"""Punch-type-first, schedule-independent sequence inference. Scores are costs, not probabilities.

Each employee's sorted, deduplicated events form a DAG. Edges consume one
unmatched event or two consecutive events as a candidate shift. Dynamic
programming chooses the lowest-cost complete sequence; a second pass forbids
each chosen pair to measure ambiguity against the next-best entire sequence.
No raw punch is ever consumed twice. Explicit confirmations constrain edges.
"""
from datetime import datetime, timedelta

MAX_OT = timedelta(hours=5)
# Matching tolerance only; does not authorize payable overtime.
OUT_MATCH_GRACE = timedelta(minutes=10)
DUPLICATE_SECONDS = 120
SINGLE_COST = 3.0
AMBIGUITY_MARGIN = 1.5
VERSION = 'typed-sequence-v15'
SHIFT_CHANGE_COST = 0.75


def bounds(day, shift):
    start = datetime.combine(day, shift['start_time'])
    end = datetime.combine(day, shift['end_time'])
    if end <= start: end += timedelta(days=1)
    return start, end


def punch_direction(value):
    if value in (0, '0'): return 'IN'
    if value in (1, '1'): return 'OUT'
    return None


def event_direction(event):
    if event['confirmed']: return event['confirmed'][2]
    directions={punch_direction(v) for v in event.get('raw_types', [])} - {None}
    return next(iter(directions)) if len(directions)==1 else None


def type_conflict(event):
    return len({punch_direction(v) for v in event.get('raw_types', [])} - {None}) > 1


def consolidate(rows, assignments):
    events = []
    for row in sorted(rows, key=lambda r: (r[5], r[7])):
        assignment = assignments.get((row[3], row[5]))
        raw_type = row[8] if len(row)>8 else None
        if events and (row[5]-events[-1]['at']).total_seconds() <= DUPLICATE_SECONDS:
            last = events[-1]
            if not (assignment and last['confirmed'] and assignment != last['confirmed']):
                last['ids'].append(row[7])
                last['raw_times'].append(row[5].isoformat())
                last['raw_types'].append(raw_type)
                if assignment and not last['confirmed']:
                    last.update(at=row[5], row=row, confirmed=assignment)
                continue
        events.append(dict(at=row[5], row=row, ids=[row[7]], raw_times=[row[5].isoformat()],
                           raw_types=[raw_type], confirmed=assignment))
    return events


def pair_candidates(a, b, shifts, extended_names=(), review_only=False):
    if not review_only:
        if any(type_conflict(e) and not e['confirmed'] for e in (a,b)): return []
        if event_direction(a)=='OUT' or event_direction(b)=='IN': return []
    typed_pair = event_direction(a)=='IN' and event_direction(b)=='OUT'

    duration = b['at'] - a['at']
    if duration <= timedelta(minutes=2) or duration >= timedelta(hours=24): return []
    result = []
    for offset in (-1, 0, 1):
        day = a['at'].date() + timedelta(days=offset)
        for name, shift in shifts.items():
            start, end = bounds(day, shift)
            ca, cb = a['confirmed'], b['confirmed']
            if ca and ca != (day, name, 'IN'): continue
            if cb and cb != (day, name, 'OUT'): continue
            fully_confirmed = bool(ca and cb)
            extended = (name in extended_names and duration <= timedelta(hours=18)
                        and a['at'] < end and start < b['at'])
            if not fully_confirmed and not (a['at'] < end and start < b['at'] <= end + MAX_OT + OUT_MATCH_GRACE) and not extended: continue
            early = max(0, (start-a['at']).total_seconds()/3600)
            late = max(0, (a['at']-start).total_seconds()/3600)
            undertime = max(0, (end-b['at']).total_seconds()/3600)
            overtime = max(0, (b['at']-end).total_seconds()/3600)
            # Lateness is a status, not proof that the scan was not an IN.
            # Bound its matching cost for a substantial period starting inside
            # the shift; retain the actual timestamp and review unusual starts.
            late_cost = late * 1.5
            if start <= a['at'] < end and duration >= timedelta(hours=4):
                late_cost = min(late_cost, 2.0)
            # An arrival within the early-arrival window is not evidence for
            # reversing an entire work/rest sequence into the opposite shift.
            early_cost = min(early, .5) if early <= 2 else early
            cost = early_cost + late_cost + undertime*1.5 + overtime/5
            if not fully_confirmed and not typed_pair and cost >= 2*SINGLE_COST: continue
            unusual = early > 2 or late > 2 or undertime > 2 or duration < timedelta(hours=4)
            reasons = set() if not unusual or fully_confirmed else {'ATYPICAL_DURATION_OR_ENDPOINT'}
            if not fully_confirmed and any(event_direction(e) is None for e in (a,b)):
                reasons.add('UNKNOWN_PUNCH_TYPE_INFERRED')
            # Valid typed endpoints determine direction; timing ranks the shift.
            if typed_pair and not fully_confirmed: cost = 2.0 * cost / (2.0 + cost)
            if not fully_confirmed and b['at'] > end + MAX_OT:
                reasons.add('EXTENDED_PERIOD_REQUIRES_REVIEW' if b['at'] > end + MAX_OT + OUT_MATCH_GRACE
                            else 'OUTSIDE_OVERTIME_LIMIT_WITHIN_MATCH_GRACE')
            result.append(dict(day=day, shift=shift, name=name, tin=a, tout=b,
                               cost=-20 if fully_confirmed else cost- (1 if ca or cb else 0),
                               reasons=reasons,
                               confirmed=fully_confirmed, typed_pair=typed_pair))
    return result


def solve(events, edges, forbidden=None, single_costs=None):
    """Choose a complete path with a bounded preference for shift continuity.

    Unlike anchors, this is path-dependent: only a pair actually selected on
    the path contributes the preceding shift. Singletons supply no new shift
    evidence. Each independent episode starts with no prior preference.
    Confirmed target pairs pay no change cost. Review margins use this same
    objective so a weak preference is never presented as a confirmation.
    """
    n = len(events)
    names = {c['name'] for candidates in edges.values() for c in candidates}
    states = [None] + sorted(names)
    costs = [{name: 0.0 for name in states} for _ in range(n + 1)]
    steps = [{} for _ in range(n)]
    for i in range(n - 1, -1, -1):
        for previous in states:
            single = single_costs[i] if single_costs is not None else SINGLE_COST
            best = single + costs[i + 1][previous]
            step = (i + 1, None, previous)
            for c in edges.get(i, []):
                if (i, c['day'], c['name']) == forbidden:
                    continue
                change = (SHIFT_CHANGE_COST if previous is not None
                          and previous != c['name'] and not c['confirmed']
                          and not c.get('typed_pair') else 0.0)
                candidate = c['cost'] + change + costs[i + 2][c['name']]
                if candidate < best:
                    best = candidate
                    step = (i + 2, c, c['name'])
            costs[i][previous] = best
            steps[i][previous] = step
    chosen = []
    i, previous = 0, None
    while i < n:
        nxt, candidate, previous = steps[i][previous]
        chosen.append((i, candidate))
        i = nxt
    return costs[0][None], chosen


def single_candidate(event, shifts, completed=()):
    if event['confirmed']:
        day,name,role=event['confirmed']
        if name in shifts:
            return dict(day=day,name=name,shift=shifts[name],tin=event if role=='IN' else None,
                        tout=event if role=='OUT' else None,reasons=set(),confirmed=True)
        return dict(day=day,name=None,shift=None,tin=None,tout=None,reasons={'INVALID_CONFIRMATION'},confirmed=False)
    if type_conflict(event):
        return dict(day=event['at'].date(), name=None, shift=None, tin=None, tout=None,
                    reasons={'CONFLICTING_DUPLICATE_PUNCH_TYPES'}, confirmed=False)
    direction = event_direction(event)
    if direction:
        options=[]
        for offset in (-1,0,1):
            day=event['at'].date()+timedelta(days=offset)
            for name,shift in shifts.items():
                start,end=bounds(day,shift)
                anchor=start if direction=='IN' else end
                if direction=='IN' and not start-timedelta(hours=12) <= event['at'] < end: continue
                if direction=='OUT' and not start < event['at'] <= end+MAX_OT+OUT_MATCH_GRACE: continue
                options.append((abs((event['at']-anchor).total_seconds()),day,name,shift))
        options.sort(key=lambda x:(x[0],x[2],x[1]))
        reasons=set()
        if not options:
            day,name,shift=event['at'].date(),None,None
            reasons.add('UNRESOLVED_SHIFT_FOR_TYPED_PUNCH')
        else:
            distance,day,name,shift=options[0]
            if distance > 2*3600: reasons.add('ATYPICAL_TYPED_ENDPOINT')
            if len(options)>1 and options[1][0]-distance<3600:
                reasons.add('AMBIGUOUS_SHIFT_FOR_TYPED_PUNCH')
        return dict(day=day,name=name,shift=shift,tin=event if direction=='IN' else None,
                    tout=event if direction=='OUT' else None,reasons=reasons,confirmed=False)
    # Context is drawn only from completed selected pairs, never from another
    # singleton. Future pairs cannot establish a historical pattern.
    recent=[r for r in completed if r['tin'] and r['tout'] and
           r['tout']['at'] < event['at'] and
           event['at']-r['tout']['at'] <= timedelta(days=14)]
    prior=[r for r in recent if r['confirmed'] or not (r['reasons'] - {'UNKNOWN_PUNCH_TYPE_INFERRED'})]
    prior=sorted(prior,key=lambda r:r['tout']['at'])[-5:]
    # Stop using an older majority when the newest reliable pair contradicts it.
    counts={name:sum(r['name']==name for r in prior) for name in shifts}
    dominant=max(counts,key=counts.get) if counts else None
    if (not dominant or counts[dominant]<3 or counts[dominant]/len(prior)<0.75
            or prior[-1]['name'] != dominant):
        dominant=None
    # A selected prior period can support a repeated next-day arrival even
    # when the pair itself is under review. This remains a weak proposal.
    previous=max(recent,key=lambda r:r['tout']['at']) if recent else None
    repeat_name=None
    repeat_weight=.75
    if previous:
        elapsed=(event['at']-previous['tin']['at']).total_seconds()/3600
        rest=event['at']-previous['tout']['at']
        if (20<=elapsed<=73 and abs((elapsed+12)%24-12)<=1
                and timedelta(hours=4)<=rest<=timedelta(hours=73)):
            repeat_name=previous['name']
            # Two preceding complete periods support an early arrival even
            # when its clock time is also close to the other shift's OUT.
            repeated=[r for r in recent if r['name']==repeat_name and
                      abs(((event['at']-r['tin']['at']).total_seconds()/3600+12)%24-12)<=1]
            if len(repeated)>=2:repeat_weight=1.5
    # New repeated-arrival evidence must not be cancelled by an older regime.
    if repeat_name and dominant != repeat_name:
        dominant = None
    options=[]
    for offset in (-1,0,1):
        day=event['at'].date()+timedelta(days=offset)
        for name,shift in shifts.items():
            start,end=bounds(day,shift)
            for role,anchor in [('IN',start),('OUT',end)]:
                distance=abs((event['at']-anchor).total_seconds())/3600
                if role=='OUT' and event['at']>end+MAX_OT:continue
                cost=distance
                support=[]
                if repeat_name and not (role=='IN' and name==repeat_name and day==event['at'].date()):
                    cost+=repeat_weight
                    support.append('SIMILAR_NEXT_DAY_ARRIVAL')
                if dominant:
                    if name!=dominant:cost+=0.75
                    support.append('RECENT_COMPLETED_PATTERN')
                # An OUT would imply a shift spanning a period already closed.
                # This is supporting evidence only; multiple visits are possible.
                if role=='OUT' and any(start < r['tout']['at'] and r['tin']['at'] < end for r in prior):
                    cost+=1.0
                    support.append('PREVIOUS_PERIOD_ALREADY_CLOSED')
                record=dict(day=day,name=name,shift=shift,tin=event if role=='IN' else None,
                            tout=event if role=='OUT' else None,
                            reasons={'SINGLE_PUNCH_DIRECTION_UNCONFIRMED'},confirmed=False)
                options.append((cost,distance,record,support))
    options.sort(key=lambda x:x[0])
    if options and options[0][1]<=2 and (len(options)==1 or options[1][0]-options[0][0]>=1):
        result=options[0][2]
        # A contextual proposal is still explicitly unconfirmed.
        if any(o[3] for o in options):result['reasons'].add('CONTEXT_SUPPORTED_SINGLE_PUNCH')
    else:
        result=dict(day=event['at'].date(),name=None,shift=None,tin=None,tout=None,
                    reasons={'UNRESOLVED_SINGLE_PUNCH'},confirmed=False)
    result['alternatives']=[proposal(o[2]) for o in options if o[1]<=2 and proposal(o[2])!=proposal(result)]
    return result


def proposal(record):
    """JSON-safe interpretation; references raw IDs without consuming them."""
    return dict(attendance_date=record['day'].isoformat(), shift=record['name'],
                time_in=record['tin']['at'].isoformat() if record['tin'] else None,
                time_out=record['tout']['at'].isoformat() if record['tout'] else None)


def preserve_incomplete_periods(records, shifts):
    """Prefer reviewed partial periods when BOTH endpoints repeat opposite roles.

    This is a proposal, not proof of the employee's schedule. Keep the complete
    pair as an alternative. Only preceding complete periods provide evidence;
    partial proposals never reinforce later proposals. Confirmations win.
    """
    result = []
    complete = [r for r in records if r['tin'] and r['tout']]
    def clock_distance(a, b):
        return abs(((a - b).total_seconds() / 3600 + 12) % 24 - 12)
    for record in records:
        a, b = record['tin'], record['tout']
        if not a or not b or a['confirmed'] or b['confirmed'] or event_direction(a) or event_direction(b):
            result.append(record)
            continue
        prior = sorted((r for r in complete if
                        timedelta(0) < a['at'] - r['tout']['at'] <= timedelta(days=14)
                        and not (r['reasons'] & {'MULTIPLE_OCCURRENCES_SAME_DATE',
                            'ATYPICAL_DURATION_OR_ENDPOINT'})),
                       key=lambda r: r['tout']['at'])[-5:]
        names = {r['name'] for r in prior}
        dominant = max(names, key=lambda n: sum(r['name'] == n for r in prior)) if names else None
        history = [r for r in prior if r['name'] == dominant]
        if (len(history) < 3 or len(history) / len(prior) < .75
                or prior[-1]['name'] != dominant or dominant == record['name']
                or a['at'] - prior[-1]['tout']['at'] > timedelta(hours=73)):
            result.append(record)
            continue
        # An alleged IN repeats established departures, and its alleged OUT
        # repeats established arrivals. Missing IN + next IN is now a viable
        # alternative to a shift change. A single similar scan is insufficient.
        if (sum(clock_distance(a['at'], r['tout']['at']) <= 1 for r in history) < 2
                or sum(clock_distance(b['at'], r['tin']['at']) <= 1 for r in history) < 3):
            result.append(record)
            continue
        shift = shifts[dominant]
        out_options = []
        in_options = []
        for offset in (-1, 0, 1):
            out_day = a['at'].date() + timedelta(days=offset)
            start, end = bounds(out_day, shift)
            if start < a['at'] <= end + MAX_OT + OUT_MATCH_GRACE:
                out_options.append((abs(a['at'] - end), out_day))
            in_day = b['at'].date() + timedelta(days=offset)
            start, _ = bounds(in_day, shift)
            if abs(b['at'] - start) <= timedelta(hours=2):
                in_options.append((abs(b['at'] - start), in_day))
        if not out_options or not in_options:
            result.append(record)
            continue
        out_day = min(out_options)[1]
        in_day = min(in_options)[1]
        if (in_day != out_day + timedelta(days=1)
                or any(r is not record and r['day'] in (out_day, in_day) for r in records)):
            result.append(record)
            continue
        alternatives = record.get('alternatives', []) + [proposal(record)]
        for day, role, event in [(out_day, 'OUT', a), (in_day, 'IN', b)]:
            result.append(dict(day=day, name=dominant, shift=shift,
                tin=event if role == 'IN' else None,
                tout=event if role == 'OUT' else None,
                events=[event], confirmed=False, margin=None,
                reasons={'HISTORY_SUPPORTED_PARTIAL_PERIOD', 'AMBIGUOUS_SHIFT_CHANGE',
                         'SINGLE_PUNCH_DIRECTION_UNCONFIRMED'},
                alternatives=list(alternatives)))
    return result


def infer_employee(rows, shifts, assignments):
    events=consolidate(rows,assignments)
    # A >=24h gap cannot belong to any eligible pair (pair_candidates rejects
    # durations >=24h). Solve these independent episodes with independent
    # context too: an old night anchor must not veto a new day phase after rest.
    episodes=[]
    for event in events:
        if not episodes or event['at']-episodes[-1][-1]['at'] >= timedelta(hours=24):
            episodes.append([])
        episodes[-1].append(event)
    records = [record for episode in episodes for record in _infer_episode(episode, shifts)]
    return review_typed_records(records, events, shifts)


def _infer_episode(events, shifts):
    edges={i:pair_candidates(events[i],events[i+1],shifts) for i in range(len(events)-1)}
    # A payroll overtime limit must not erase a plausible departure and make
    # the next arrival its OUT. Permit an exceptional reviewed candidate only
    # when a third scan supports the next day's arrival in the same phase.
    # Employee IDs and roster assignments are not consulted; direction constraints still apply.
    for i in range(len(events)-2):
        a,b,next_in=events[i:i+3]
        if not (timedelta(hours=23) <= next_in['at']-a['at'] <= timedelta(hours=25)
                and timedelta(hours=4) <= next_in['at']-b['at'] <= timedelta(hours=20)):
            continue
        names=[]
        for name,shift in shifts.items():
            start,_=bounds(a['at'].date(),shift)
            if (abs(a['at']-start)<=timedelta(hours=2)
                    and abs(next_in['at']-(start+timedelta(days=1)))<=timedelta(hours=2)
                    and (not next_in['confirmed'] or next_in['confirmed']==(start.date()+timedelta(days=1),name,'IN'))):
                names.append(name)
        if names:
            edges[i]=pair_candidates(a,b,shifts,names)
    # Only clear, locally uncontested pairs can support a recent pattern.
    # The immutable baseline prevents inferred choices reinforcing themselves.
    anchors=[]
    for i, candidates in edges.items():
        for c in candidates:
            rivals=[alt for k in (i-1,i,i+1) for alt in edges.get(k,[])
                    if alt is not c]
            start, end = bounds(c['day'], c['shift'])
            # A completed pair close to BOTH configured boundaries supports
            # arrival history even when an adjacent overnight alternative
            # shares its morning scan. It is evidence, not a confirmed role.
            # Compare shift alternatives for these same endpoints separately.
            same_endpoints = [alt for alt in candidates if alt is not c]
            boundary_supported = (
                abs(c['tin']['at'] - start) <= timedelta(hours=2) and
                abs(c['tout']['at'] - end) <= timedelta(hours=1) and
                all(alt['cost'] - c['cost'] >= AMBIGUITY_MARGIN for alt in same_endpoints)
            )
            if not (c['reasons'] - {'UNKNOWN_PUNCH_TYPE_INFERRED'}) and (c['confirmed'] or
                    (c['cost'] < 2 and (boundary_supported or
                     all(alt['cost']-c['cost'] >= AMBIGUITY_MARGIN for alt in rivals)))):
                anchors.append(c)
    anchors=[dict(a,reasons=set(a['reasons'])) for a in anchors]
    # Establish repeated arrival evidence from uncontested baseline periods,
    # before selecting pairs. It is a bounded preference, not a forced shift.
    arrival_support={}
    for i,event in enumerate(events):
        supporting=[a for a in anchors if a['tout']['at'] < event['at'] and
                    timedelta(hours=20) <= event['at']-a['tin']['at'] <= timedelta(hours=73) and
                    abs(((event['at']-a['tin']['at']).total_seconds()/3600+12)%24-12)<=1]
        # A local IN/OUT/next-IN hypothesis can support a repeated arrival
        # without older anchors (e.g. after leave or a gap). Use only an
        # eligible preceding pair and similar next-day arrival, with >=4h
        # work and >=4h rest. It remains a soft competing interpretation.
        if i >= 2 and not event['confirmed']:
            first, middle = events[i-2], events[i-1]
            elapsed = event['at'] - first['at']
            rest = event['at'] - middle['at']
            if (timedelta(hours=23) <= elapsed <= timedelta(hours=25) and
                    timedelta(hours=4) <= rest <= timedelta(hours=20)):
                for candidate in edges.get(i-2, []):
                    start, _ = bounds(candidate['day'], candidate['shift'])
                    next_start, _ = bounds(candidate['day'] + timedelta(days=1), candidate['shift'])
                    if (middle['at'] - first['at'] >= timedelta(hours=4) and
                            abs(first['at'] - start) <= timedelta(hours=2) and
                            abs(event['at'] - next_start) <= timedelta(hours=2)):
                        # The opposite phase of a repeating work/rest cycle also
                        # repeats every 24h. It is not independent arrival evidence.
                        # Prefer the latest reliable completed pair when interpreting
                        # this weak local repetition; genuine shift candidates remain
                        # available to the sequence solver and confirmations prevail.
                        prior = [a for a in anchors if a['tout']['at'] < first['at']
                                 and first['at'] - a['tout']['at'] <= timedelta(days=14)]
                        latest = max(prior, key=lambda a: a['tout']['at']) if prior else None
                        if latest is None or latest['name'] == candidate['name']:
                            supporting.append(candidate)
        names={a['name'] for a in supporting}
        if len(names)==1:arrival_support[i]=next(iter(names))
    for i,candidates in edges.items():
        for c in candidates:
            c['base_cost']=c['cost']
            if not c['confirmed'] and not event_direction(c['tout']) and arrival_support.get(i+1):
                # Consuming a repeated arrival as OUT competes with starting a
                # new period. Keep this alternative possible and reviewable.
                c['cost']+=2.0
                c['reasons'].add('REPEATED_ARRIVAL_USED_AS_OUT')
    for candidates in edges.values():
        for c in candidates:
            prior=[a for a in anchors if timedelta(0) < c['tin']['at']-a['tout']['at'] <= timedelta(days=14)]
            prior=sorted(prior,key=lambda a:a['tout']['at'])[-5:]
            counts={name:sum(a['name']==name for a in prior) for name in shifts}
            dominant=max(counts,key=counts.get) if counts else None
            if (dominant and counts[dominant]>=3 and counts[dominant]/len(prior)>=0.75
                    and prior[-1]['name'] == dominant):
                # Small penalty, never a constraint on changing shifts.
                if not c['confirmed'] and not c.get('typed_pair') and c['name']!=dominant:c['cost']+=0.75
                c['pattern_support']=dominant
    chunks=[]
    for idx,event in enumerate(events):
        if not chunks or event['at']-events[chunks[-1][-1]]['at']>=timedelta(hours=24):chunks.append([])
        chunks[-1].append(idx)
    records=[]
    for indices in chunks:
        chunk=[events[i] for i in indices]
        local_edges={j:edges.get(i,[]) for j,i in enumerate(indices[:-1])}
        singles=[single_candidate(e,shifts,anchors) for e in chunk]
        # A clearly placed singleton is preferable to an unexplained scan.
        # Endpoint proximity breaks small ties; never labels a singleton final.
        single_costs=[]
        for index,(e,c) in enumerate(zip(chunk,singles)):
            if c['confirmed']:single_costs.append(SINGLE_COST)
            elif c['shift']:
                start,end=bounds(c['day'],c['shift'])
                anchor=start if c['tin'] else end
                single_costs.append(SINGLE_COST+abs((e['at']-anchor).total_seconds())/3600)
            else:
                # Leaving a scan unexplained costs more when it can begin a
                # substantial work period. A following morning IN can remain
                # open without requiring a missing OUT during an active day.
                plausible = any(c['tin'] is e and c['tout']['at']-e['at'] >= timedelta(hours=4)
                                for c in local_edges.get(index, []))
                single_costs.append(2*SINGLE_COST if plausible else SINGLE_COST+1)
        # An interior unclosed arrival requires a missing scan; the newest
        # arrival may simply still be at work. Use this only as a soft prior.
        for index,c in enumerate(singles):
            if c['tin'] and not c['confirmed'] and index < len(chunk)-1:
                single_costs[index] += 0.75
        best,chosen=solve(chunk,local_edges,single_costs=single_costs)
        for i,c in chosen:
            if c is None:
                c=dict(singles[i]);c['events']=[chunk[i]];c['margin']=None
            else:
                c=dict(c);c['reasons']=set(c['reasons']);c['events']=[chunk[i],chunk[i+1]]
                alternative,_=solve(chunk,local_edges,(i,c['day'],c['name']),single_costs)
                c['margin']=round(alternative-best,4)
                if c['margin']<AMBIGUITY_MARGIN and not c['confirmed']:c['reasons'].add('AMBIGUOUS_SEQUENCE')
                competing=[alt for k in (i-1,i,i+1) for alt in local_edges.get(k,[])
                           if not (k==i and alt['day']==c['day'] and alt['name']==c['name'])]
                if not c['confirmed'] and any(alt.get('base_cost',alt['cost'])<=c.get('base_cost',c['cost'])+1 for alt in competing):
                    c['reasons'].add('COMPETING_PUNCH_PAIR')
            c['alternatives']=c.get('alternatives',[])+[proposal(alt) for k in (i-1,i,i+1) for alt in local_edges.get(k,[])
                               if any(e is alt['tin'] or e is alt['tout'] for e in c['events'])
                               and proposal(alt)!=proposal(c)]
            records.append(c)
    # Pair selection is finished before context resolves singleton directions.
    # Context cannot steal a paired punch or form a self-reinforcing chain.
    completed=[r for r in records if r['tin'] and r['tout']]
    for index,record in enumerate(records):
        if len(record['events'])!=1 or record['confirmed']:continue
        resolved=single_candidate(record['events'][0],shifts,completed)
        resolved['events']=record['events'];resolved['margin']=record['margin']
        alternatives=record.get('alternatives',[])+resolved.get('alternatives',[])
        resolved['alternatives']=[]
        for alt in alternatives:
            if alt!=proposal(resolved) and alt not in resolved['alternatives']:
                resolved['alternatives'].append(alt)
        records[index]=resolved
    return preserve_incomplete_periods(records, shifts)


def review_typed_records(records, events, shifts):
    """Retain raw directions and attach suggestions; never silently reverse one."""
    positions={id(e):i for i,e in enumerate(events)}
    for record in records:
        if record['confirmed']: continue
        if any(type_conflict(e) for e in record['events']):
            record['reasons'].add('CONFLICTING_DUPLICATE_PUNCH_TYPES')
        if len(record['events'])!=1: continue
        event=record['events'][0]; i=positions[id(event)]; direction=event_direction(event)
        if not direction:
            record['reasons'].add('UNKNOWN_PUNCH_TYPE')
            continue
        if direction=='IN' and i+1<len(events) and event_direction(events[i+1])=='IN':
            record['reasons'].add('REPEATED_IN_OR_WRONG_PUNCH_TYPE')
        if direction=='OUT' and i>0 and event_direction(events[i-1])=='OUT':
            record['reasons'].add('REPEATED_OUT_OR_WRONG_PUNCH_TYPE')
        # Offer reversal only for same-direction neighbors, not normal OUT/IN rest.
        for j in (i-1,i):
            if j<0 or j+1>=len(events): continue
            a,b=events[j:j+2]
            if event_direction(a)!=direction or event_direction(b)!=direction: continue
            for candidate in pair_candidates(a,b,shifts,review_only=True):
                alt=proposal(candidate)
                if alt not in record.setdefault('alternatives',[]):record['alternatives'].append(alt)
        if direction=='IN' and i+1<len(events):
            record['reasons'].add('UNCLOSED_IN_BEFORE_LATER_PUNCH')
    return records


def summarize_day(parts, now):
    """Select one occurrence without joining unrelated endpoints; retain review."""
    selected=min(parts,key=lambda p:(not p['confirmed'],p['events'][0]['at']))
    tin,tout,shift=selected['tin'],selected['tout'],selected['shift']
    reasons=set().union(*(p['reasons'] for p in parts))
    if len(parts)>1: reasons.add('MULTIPLE_OCCURRENCES_SAME_DATE')
    if tin and tout and tin['at']>=tout['at']:
        tin=tout=None
        reasons.add('INVALID_ENDPOINT_ORDER')
    unresolved=any(not p['tin'] and not p['tout'] for p in parts)
    if tin is None: reasons.add('UNRESOLVED_IN' if unresolved else 'MISSING_IN')
    end=bounds(selected['day'],shift)[1] if shift else None
    ongoing=bool(tin and not tout and end and now<=end+MAX_OT
                 and 'UNCLOSED_IN_BEFORE_LATER_PUNCH' not in reasons)
    if tout is None:
        reasons.add('UNRESOLVED_OUT' if unresolved else ('PENDING_OUT' if ongoing else 'MISSING_OUT'))
    if reasons - {'PENDING_OUT'}: status='NEEDS_REVIEW'
    elif ongoing: status='PROVISIONAL'
    elif all(p['confirmed'] for p in parts): status='CONFIRMED'
    else: status='INFERRED'
    return tin,tout,shift,reasons,status

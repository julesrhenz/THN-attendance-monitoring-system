from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image, KeepTogether

OUT = Path('output/pdf/THN_Attendance_User_Manual.pdf')
LOGO = Path('frontend/employee_grouping_system/static/images/logo.png')
OUT.parent.mkdir(parents=True, exist_ok=True)
NAVY='#0B2545'; BLUE='#2E74B5'; DARK='#1F4D78'; GRAY='#5B6573'; LIGHT='#E8EEF5'; PALE='#F4F6F9'

styles=getSampleStyleSheet()
styles.add(ParagraphStyle('CoverBrand', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=12, leading=15, textColor=colors.HexColor(BLUE), alignment=TA_CENTER, spaceAfter=8))
styles.add(ParagraphStyle('CoverTitle', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=27, leading=33, textColor=colors.HexColor(NAVY), alignment=TA_CENTER, spaceAfter=8))
styles.add(ParagraphStyle('CoverSub', parent=styles['Normal'], fontName='Helvetica', fontSize=16, leading=20, textColor=colors.HexColor(GRAY), alignment=TA_CENTER, spaceAfter=28))
styles.add(ParagraphStyle('H1x', parent=styles['Heading1'], fontName='Helvetica-Bold', fontSize=16, leading=20, textColor=colors.HexColor(BLUE), spaceBefore=15, spaceAfter=8, keepWithNext=True))
styles.add(ParagraphStyle('H2x', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=12.5, leading=16, textColor=colors.HexColor(BLUE), spaceBefore=10, spaceAfter=5, keepWithNext=True))
styles.add(ParagraphStyle('Bodyx', parent=styles['BodyText'], fontName='Helvetica', fontSize=9.6, leading=13.2, textColor=colors.HexColor(NAVY), spaceAfter=6))
styles.add(ParagraphStyle('Bulletx', parent=styles['BodyText'], fontName='Helvetica', fontSize=9.4, leading=12.5, textColor=colors.HexColor(NAVY), leftIndent=15, firstLineIndent=-8, spaceAfter=3))
styles.add(ParagraphStyle('Smallx', parent=styles['BodyText'], fontName='Helvetica', fontSize=8.5, leading=11, textColor=colors.HexColor(GRAY), spaceAfter=3))
styles.add(ParagraphStyle('Notex', parent=styles['BodyText'], fontName='Helvetica', fontSize=9.2, leading=12.2, textColor=colors.HexColor(DARK), spaceAfter=0))

def P(text, style='Bodyx'): return Paragraph(text, styles[style])
def bullets(items): return [P('• '+x,'Bulletx') for x in items]
def steps(items): return [P(f'{i}. {x}','Bulletx') for i,x in enumerate(items,1)]
def note(title, text):
    t=Table([[P(f'<b>{title}</b>&nbsp;&nbsp;{text}','Notex')]], colWidths=[6.5*inch])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor(PALE)),('BOX',(0,0),(-1,-1),.3,colors.HexColor('#CAD6E5')),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
    return [t,Spacer(1,7)]
def table(headers, rows, widths):
    data=[[P(f'<b>{h}</b>','Smallx') for h in headers]]+[[P(c,'Smallx') for c in row] for row in rows]
    t=Table(data,colWidths=[w*inch for w in widths], repeatRows=1, hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor(LIGHT)),('TEXTCOLOR',(0,0),(-1,0),colors.HexColor(DARK)),('GRID',(0,0),(-1,-1),.3,colors.HexColor('#B8C5D3')),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
    return [t,Spacer(1,7)]
def page(canvas, doc):
    canvas.saveState(); canvas.setStrokeColor(colors.HexColor('#D8E0EA')); canvas.line(.75*inch,10.48*inch,7.75*inch,10.48*inch)
    canvas.setFillColor(colors.HexColor(GRAY)); canvas.setFont('Helvetica-Bold',7.5); canvas.drawRightString(7.75*inch,10.57*inch,'TIME HUB NETWORK  |  ATTENDANCE MONITORING SYSTEM')
    canvas.setFont('Helvetica',7.5); canvas.drawCentredString(4.25*inch,.38*inch,f'Internal user guide  •  Version 1.0  •  Page {doc.page}')
    canvas.restoreState()

story=[]
story += [Spacer(1,50)]
if LOGO.exists(): story += [Image(str(LOGO),width=.82*inch,height=.82*inch),Spacer(1,13)]
story += [P('TIME HUB NETWORK','CoverBrand'),P('Attendance Monitoring System','CoverTitle'),P('User Manual Guide','CoverSub')]
story += table(['Guide purpose','Audience'],[['How to navigate, monitor attendance, manage workforce records, and use approval workflows.','Authorized users: Viewers, Supervisors, HR/Administration, and System Administrators.']],[3.25,3.25])
story += [Spacer(1,12),P('Version 1.0  |  Internal use','Smallx'),PageBreak()]

story += [P('1. Getting started','H1x'),P('The Attendance Monitoring System is a web-based workforce console for reviewing attendance, organizing personnel, maintaining employee records, and processing attendance corrections. Available actions depend on your account role, department, and assigned scope.')]
story += [P('Sign in and sign out','H2x')] + steps(['Open the system URL supplied by your administrator and enter your username and password.','Use the left navigation panel to open the required module. Your name and assigned department appear at the top.','Select Logout when finished. Do not leave an active session open on a shared computer.'])
story += note('Access-aware navigation.','If a button or menu item is not visible, it is likely outside your assigned role or department scope. Contact an Administrator rather than using another person’s account.')
story += [P('Navigation at a glance','H2x')] + table(['Module','Primary use'],[['Dashboard','Review attendance rates and weekly/monthly trend summaries.'],['Grouping','Organize staff by line, department, and shift; import or move manpower when authorized.'],['Employee Management','Find, review, create, update, or maintain employee records.'],['Attendance Logs','Review daily records, filter attendance, submit corrections, and complete approvals.'],['Scanner Management','Admin-only configuration of biometric scanner inventory.']],[1.83,4.67])

story += [P('2. Roles and access scope','H1x')] + table(['User type','Typical capability'],[['Viewer','Read-only access to authorized records; can review employee details and attendance history.'],['Supervisor','Operational workforce tasks within assigned scope, including approved imports and transfers.'],['HR / Administration','May complete final attendance-correction approval and perform administration-authorized work.'],['Administrator','Full system administration, including user provisioning, employee maintenance, and scanner setup.']],[1.83,4.67])
story += [P('Access may also be limited by department, production line, shift, or production section. For example, a line-level user sees only the assigned line and shift, while a section-level Production user sees only the assigned section.')]
story += note('Important.','Permissions are enforced by the system. Do not attempt to work around a missing action; send the request to the correct approver or system administrator.')

story += [P('3. Dashboard: monitor attendance','H1x'),P('Open Dashboard from the Overview menu to review attendance-rate summaries. The dashboard provides broad weekly and monthly views, including breakdowns that may be grouped by agency, tenure, department, or line.')]
story += bullets(['Start with the current period and identify unusually low attendance rates or high late/absent counts.','Use line or department breakdowns to focus follow-up on the affected operational area.','Treat dashboard figures as monitoring indicators. Use Attendance Logs to review the underlying employee records and punch details.','Where configured, review the daily validation indicator for THN Day Shift; it compares present/late/absent totals with the expected benchmark headcount.'])
story += [P('Recommended daily routine','H2x')] + steps(['Review the dashboard for exceptions at the beginning of the shift.','Open Attendance Logs and filter to the relevant date, shift, line, or status.','Investigate missing punches and pending correction requests.','Escalate unresolved discrepancies through the approved attendance-correction process.'])

story += [P('4. Workforce grouping','H1x'),P('The Grouping workspace organizes employees into line and shift groups. It can show departmental groupings, line summaries, unassigned employees, and movement history. Editing controls are restricted to authorized users.'),P('Find and review a group','H2x')] + steps(['Open Grouping from the Workforce menu.','Select the applicable shift and use search or line filters to narrow the view.','Expand a line group to see employees, or select Summary to review line-level totals.','Select an employee name to review recorded movement/history information.'])
story += [P('Manage manpower (authorized users)','H2x')] + steps(['Select the employees to move.','Choose Manage Manpower or the available transfer control.','Choose the destination sheet or line and section. If permitted, enter a new section name.','Confirm the transfer and verify the employee appears in the correct destination group.'])
story += note('Audit trail.','Line, shift, and process changes detected by imports or updates are retained as movement/history records, helping managers trace workforce changes.')
story += [P('Import an Excel staffing file','H2x')] + steps(['In Grouping, select Import Excel.','Choose the approved workbook and select whether to apply it immediately or schedule it for a future date and time.','Confirm the import result and review skipped sheets or error messages.','Validate affected lines and employee movements after the import is active.'])
story += [P('For best results, staffing sheets should be named with DS or NS (Day Shift or Night Shift) and include an Emp No. header. Scheduled imports activate automatically at the chosen date and time.')]

story += [P('5. Employee management','H1x'),P('Employee Management is the system directory for active workforce records. Use filters and search to locate a worker, click a row to view details, and use editing controls only when your role allows changes.'),P('Add a new employee','H2x')] + steps(['Open Employee Management and select Add New Employee.','Enter identity and employment details such as name, agency, employee number, department, position, hire date, and shift.','Set the production line where applicable. This field is generally used for non-Administration departments.','Save the record and confirm the employee appears in the directory and appropriate grouping.'])
story += [P('Tenure is calculated automatically from the hire date; do not enter it manually.')]
story += [P('Edit, leave, and deactivate records','H2x')] + bullets(['Select Edit on an employee row to update employee data. Changes are recorded in the audit trail with old and new values.','To mark staff On Leave in bulk, select the employees, provide a reason, and optionally provide a return date. Use Return to Work to clear leave status.','Bulk Delete sets an employee to INACTIVE rather than permanently erasing the record, preserving historical data. This is an Administrator-only action.'])
story += note('Data-quality check.','Before saving a change, confirm employee number, agency, department, line, shift, and hire date. These fields affect grouping, reporting, and attendance interpretation.')

story += [P('6. Attendance logs and corrections','H1x'),P('Attendance Logs contains daily time-in/time-out records and calculated attendance status. Use this module for detailed follow-up, not just summary reporting.'),P('Review and filter attendance','H2x')] + steps(['Open Attendance Logs from the Time Tracking menu.','Set filters for shift, date, status, position, or use free-text search by employee ID or name. Combine filters to focus on a specific group.','Select a column header to sort results.','Select an employee name or row to open available attendance history and statistics.'])
story += table(['Status','Meaning / action'],[['Present','Expected attendance condition is met.'],['Late','Arrival is past the shift cutoff; confirm whether a correction is required.'],['Absent','No qualifying attendance record for the shift; verify with the responsible supervisor.'],['On Leave','Employee is marked on leave in the directory; verify return-to-work status when appropriate.'],['Pending','A relevant attendance action or correction is still awaiting completion.']],[1.75,4.75])
story += [P('Handle a missing punch or correction','H2x')] + steps(['Use the Missing Punches report for the selected date and shift to identify records with only time-in or time-out.','Open the employee’s attendance record and select Edit or the correction action, if enabled for your role.','Enter the correct information and submit the request with accurate supporting details.','Monitor the approval queue or notifications until the request is resolved.'])
story += note('Two-stage approval.','Attendance corrections first go to the applicable department, line, or section approver. HR/Final Approval then completes the change; the live attendance record is updated only after final approval. Viewers cannot submit edits or act on approval requests.')

story += [P('7. Scanner management (Administrators)','H1x'),P('Scanner Management is visible only to Administrators and requires an additional scanner-access passcode. Use it to maintain the registered biometric device inventory used by attendance synchronization.')] + steps(['Open Scanner Management from System Setup and complete the additional access prompt.','Review registered scanner data, including agency, IP address, scanner type, location, port, and enabled status.','Add or edit a scanner using a valid IP address, supported type (ZKTeco or Anviz), existing agency, optional port, and location.','Disable a scanner when it should stop syncing but historical records must remain available.'])
story += note('Preserve history.','A scanner that already has biometric logs cannot be deleted. Disable it instead, so attendance history remains traceable.')

story += [P('8. Troubleshooting and good practice','H1x')] + table(['Situation','What to do'],[['A button or page is unavailable','Confirm your role and assigned scope. Ask an Administrator to review access if the action is required for your job.'],['Excel import skips a sheet','Confirm the sheet name contains DS or NS and its header includes Emp No.; correct the file and import again.'],['A staff member is missing from a line','Search Employee Management, confirm active status and shift, then use authorized grouping/transfer actions.'],['A punch is missing or wrong','Use Attendance Logs, submit a correction request, and follow it through both approval stages.'],['Scanner cannot be removed','Disable it when it contains biometric history; only unused scanners may be deleted.'],['Attendance count does not look right','Check filters, date, and shift; compare the dashboard indicator with detailed Attendance Logs before escalating.']],[2.22,4.28])
story += [P('Operational checklist','H2x')] + bullets(['Use the correct shift and date before taking action.','Check employee identity and agency before changing a record.','Use imports and bulk actions only with an approved source file and verified scope.','Review pending corrections and missing punches routinely.','Log out of shared devices and never share credentials or scanner-access passcodes.'])
story += [P('Need help?','H2x'),P('Use the in-system assistant for common how-to questions about imports, transfers, access levels, employee records, and attendance approvals. For permissions, data corrections outside your scope, or technical issues, contact your designated Administrator or Supervisor.')]

doc=SimpleDocTemplate(str(OUT),pagesize=letter,rightMargin=.75*inch,leftMargin=.75*inch,topMargin=.78*inch,bottomMargin=.65*inch,title='THN Attendance User Manual',author='Time Hub Network')
doc.build(story,onFirstPage=page,onLaterPages=page)
print(OUT.resolve())

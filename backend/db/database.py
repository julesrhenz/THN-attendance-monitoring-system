import psycopg2
from .config import CONFIG

def get_db_connection():
    conn = psycopg2.connect(**CONFIG)
    cur = conn.cursor()
    cur.execute("SET search_path TO backend, public")
    conn.commit()
    cur.close()
    return conn
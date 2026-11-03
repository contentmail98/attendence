"""
Database migration script to add institute_id column to existing students and attendance_records tables
in attendance.db if they were created under the old single-tenant schema.
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "attendance.db")

def migrate():
    if not os.path.exists(DB_PATH):
        print("Database not found, new DB will be created automatically.")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # 1. Check institutes table
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='institutes';")
    if not cursor.fetchone():
        print("Creating institutes table...")
        cursor.execute("""
            CREATE TABLE institutes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code VARCHAR NOT NULL UNIQUE,
                name VARCHAR NOT NULL,
                contact_person VARCHAR,
                contact_phone VARCHAR,
                contact_email VARCHAR,
                address VARCHAR,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        # Insert default institutes
        cursor.execute("""
            INSERT INTO institutes (code, name, contact_person, contact_phone, address)
            VALUES 
            ('apex', 'Apex Coaching Academy', 'Director Sharma', '9876543210', 'Plot 42, Knowledge Park, Delhi NCR'),
            ('allen', 'Allen Career Institute', 'Center Head Verma', '9123456789', 'Road 1, Coaching Hub, Kota');
        """)
        conn.commit()

    # Get apex institute ID as default fallback
    cursor.execute("SELECT id FROM institutes WHERE code='apex';")
    row = cursor.fetchone()
    apex_id = row[0] if row else 1

    # 2. Check students table columns
    cursor.execute("PRAGMA table_info(students);")
    cols = [c[1] for c in cursor.fetchall()]
    if "institute_id" not in cols:
        print("Adding institute_id to students table...")
        cursor.execute(f"ALTER TABLE students ADD COLUMN institute_id INTEGER DEFAULT {apex_id};")
        conn.commit()

    # 3. Check attendance_records table columns
    cursor.execute("PRAGMA table_info(attendance_records);")
    cols = [c[1] for c in cursor.fetchall()]
    if "institute_id" not in cols:
        print("Adding institute_id to attendance_records table...")
        cursor.execute(f"ALTER TABLE attendance_records ADD COLUMN institute_id INTEGER DEFAULT {apex_id};")
        conn.commit()

    conn.close()
    print("Database migration completed successfully!")

if __name__ == "__main__":
    migrate()

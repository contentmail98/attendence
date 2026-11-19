"""
Test script to simulate a biometric punch for a specific coaching institute tenant in Indian Standard Time (IST).
Usage:
  python test_event.py [institute_code] [student_id] [--live]
Example:
  python test_event.py prepx 101 --live
"""

import sys
import requests
from datetime import datetime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

INSTITUTE_CODE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "prepx"
STUDENT_ID = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "101"
IS_LIVE = "--live" in sys.argv

BASE_URL = "https://attendance-api-iw7z.onrender.com" if IS_LIVE else "http://127.0.0.1:8000"
WEBHOOK_URL = f"{BASE_URL}/api/institutes/{INSTITUTE_CODE}/events"

now_ist = datetime.now(IST)

sample_event = {
    "ipAddress": "192.168.1.120",
    "portNo": 80,
    "dateTime": now_ist.isoformat(),
    "eventType": "AccessControllerEvent",
    "deviceName": f"{INSTITUTE_CODE.upper()} Main Gate Scanner",
    "AccessControllerEvent": {
        "deviceName": f"{INSTITUTE_CODE.upper()} Terminal",
        "majorEventType": 5,
        "subEventType": 75,
        "employeeNoString": STUDENT_ID,
        "name": "Biometric User",
        "attendanceStatus": "checkIn",
    }
}

if __name__ == "__main__":
    print(f"Triggering biometric scan for Institute [{INSTITUTE_CODE.upper()}], Student ID #{STUDENT_ID}...")
    print(f"Target URL: {WEBHOOK_URL}")
    print(f"Event Time (IST): {now_ist.strftime('%Y-%m-%d %I:%M:%S %p')}")
    try:
        res = requests.post(WEBHOOK_URL, json=sample_event, timeout=10)
        print(f"Status Code: {res.status_code}")
        print(f"Response: {res.text}")
    except Exception as e:
        print(f"Error connecting: {e}")

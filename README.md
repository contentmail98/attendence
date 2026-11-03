# Hikvision Attendance Real-Time Listener (Python FastAPI)

This application listens for real-time attendance punch events pushed by Hikvision terminals (MinMoe Face Recognition, Card Readers, and Access Controllers).

---

## 1. Quick Start

### 1.1 Install Dependencies
```bash
pip install -r requirements.txt
```

### 1.2 Start the Listener Server
```bash
python main.py
```
The server will start at `http://0.0.0.0:8000`.

---

## 2. Configuring Your Hikvision Device (Alarm Server)

No complex SDK or partner license required for real-time push:

1. Open your browser and navigate to your Hikvision device's web UI (e.g. `http://192.168.1.100`).
2. Log in with your device administrator credentials (`admin` / password).
3. Go to: **Configuration** -> **Network** -> **Advanced Settings** -> **Alarm Server** (or **HTTP Listening** depending on firmware).
4. Configure the following fields:
   - **Server Type / Protocol**: `HTTP` or `URL`
   - **Server Address / IP**: Your computer / server's local LAN IP (e.g., `192.168.1.50`)
   - **Port**: `8000`
   - **URL / Path**: `/api/events` (or `/`)
5. Check **Enable** and save.
6. Trigger a scan on the terminal (face, fingerprint, or RFID card). The punch event and snapshot image (if enabled) will immediately stream to your terminal and log file `hikvision_events.log`.

---

## 3. Endpoints

- `POST /api/events` - Receives JSON or Multipart punch events and snapshot photos.
- `GET /health` - Verifies server health status.

# 🎯 Pose & Gaze Tracking Agent for MediaStage

This project implements a **MediaStage / LiveKit agent** for **collecting user tracking data** within a MediaStage room.

The agent allows you to analyze **how users visually interact** with a session by combining:
- **Body pose**
- **Gaze direction**
- **Head position**
- **Visible layout and page focus state**

All data is stored persistently in a **SQLite database**, organized per session (room).

---

## ✨ What the agent does

Once activated in a room, the agent:

- 📹 Automatically subscribes to participants' **video streams**.
- 🧍 Detects **body pose** using *MediaPipe Pose*.
- 👀 Estimates **gaze and head orientation** using *MediaPipe Face Mesh*.
- 🖼️ Receives **snapshots of the visible layout** (active layout, visible entities, page focus).
- 💾 Stores all information on disk, separated by room.

Each MediaStage room can activate this agent independently.

---

## 🧩 General architecture

1. The agent registers as an **Agent Worker** in MediaStage.
2. It is manually dispatched to a specific room.
3. The agent:
   - Connects to the room.
   - Subscribes to video tracks.
   - Processes frames at controlled FPS.
   - Listens for `data` messages with layout snapshots.
4. Data is stored in a per-session SQLite database.
5. Data can be played back or analyzed offline.

```
data/
 └── <room_name>/
     └── data.db
```

---

## 📦 Requirements

- Python 3.9+
- LiveKit Agents SDK
- [LK (livekit cli)](https://docs.livekit.io/intro/basics/cli/start/#get-started)
- MediaPipe
- OpenCV
- SQLite3

The project includes a **`requirements.txt`** with all necessary dependencies.

⚠️ **Important**  
Dependencies should be installed **without automatically resolving other dependencies** to avoid version conflicts (especially with MediaPipe and LiveKit).

```
pip install -r requirements.txt --no-deps
```

---

## 🚀 Registering the agent in MediaStage

Before using the agent in a room, start it as a service:

```
python3 GazePoseAgent.py start
```

This:
- Registers the agent with the identity:  **pose-gaze-agent**
- Leaves the agent waiting for jobs from MediaStage.

---

## 🎛️ Activating the agent in a room

To associate the agent with a specific room, use a manual dispatch:

```
bash dispatchTask.sh
```

Script content:

```
lk dispatch create   --agent-name pose-gaze-agent   --room 698336196ae08a346840e2f2   --url wss://creativestudio.amplifyproject.eu/live   --api-key <API_KEY>   --api-secret <API_SECRET>
```

### 🆔 What is the room / room_name?

The `--room` value **must match the `sessionId` in MediaStage**.

This `sessionId`:
- Appears in the **browser URL** when entering a MediaStage session.
- Is used by the agent to:
  - Create the data folder
  - Name the session database

Example URL:

```
https://creativestudio.amplifyproject.eu/host?sessionId=698336196ae08a346840e2f2
```

room_name = 698336196ae08a346840e2f2

Data will be saved in:

```
data/698336196ae08a346840e2f2/data.db
```

---

## 📊 Collected data

### 🧍 Pose & Gaze (per video track)

Table: **pose_gaze**

- ts → Monotonic timestamp  
- track_id → Video track ID  
- pose_detected → Pose detected (0/1)  
- face_detected → Face detected (0/1)  
- pose_landmarks → MediaPipe Pose landmarks (JSON)  
- head_xy → Normalized head position  
- gaze_vector → Normalized gaze vector  

Frequency:
- POSE_FPS = 10
- FACE_FPS = 10

---

### 🖼️ Visible layout

Table: **layouts**

Saved every time the agent receives a `data` message with:

```
{
  "name": "layout_snapshot",
  "payload": {
    "layout": "grid",
    "entities": {...},
    "visibility": {...}
  }
}
```

Fields:
- ts_recv → Timestamp of reception
- layout_type → Active layout type
- entities → Visible entities (JSON)
- visibility → Visibility / focus state

---

## 🗂️ Database

- One database **per room**
- Automatically created when the agent joins
- Format: **SQLite**

```
data/
 └── <room_name>/
     └── data.db
```

---

## ▶️ Playing back data

Basic player (pose + gaze):

```
python3 player.py data/<room_name>/data.db
```

Player with layout:

```
python3 player_layout.py data/<room_name>/data.db
```

This second player:
- Considers the active layout
- Synchronizes pose, gaze, and entity visibility

---

## 🔎 Accessing raw data

You can open the database with any SQLite viewer, for example:
- DB Browser for SQLite
- sqlitebrowser

```
sqlitebrowser data/<room_name>/data.db
```

---

## ℹ️ Important notes

- The agent is **headless and hidden**.
- Does not publish audio or video.
- Video is reduced to **640px width** for performance.
- Supports multiple simultaneous tracks.
- Agent activation is **manual** for now.

---

## 🧪 Project status

- ✅ Pose & gaze tracking  
- ✅ Visible layout capture  
- ✅ Session persistence  
- ✅ Offline playback  
- ⏳ Dispatch automation (pending)

# mediaStage – Architecture Documentation

## Overview

**mediaStage** is a web‑based architecture for advanced real‑time multimedia orchestration, built on top of **LiveKit** and **WebRTC**. It is designed for collaborative and controlled scenarios in which a central authority (the *host*) governs how media streams, layouts, and interactions are composed and experienced by multiple participants.

The system combines a modern **Next.js + React** web interface with a set of **independent Python agents** that provide tracking, synchronization, and data persistence capabilities. Together, these components enable fine‑grained control over audiovisual flows, shared state consistency, and the collection of multimodal signals (pose, gaze, interaction data) for downstream analysis or AI model training.

mediaStage is conceived as a modular and extensible platform, suitable not only for videoconferencing, but also for research, creative collaboration, and future real‑time media experimentation.

---

## Architectural Foundations

At its core, mediaStage relies on **LiveKit** as the real‑time communication backbone, using **WebRTC** for low‑latency audio and video transport. LiveKit rooms act as the central coordination point where browsers and Python agents coexist as first‑class participants.

The architecture follows a clear separation of concerns:

- **Presentation and interaction** are handled by the web client.
- **Orchestration and control** are driven by the host role and propagated through shared state.
- **Computation, tracking, and persistence** are delegated to autonomous Python agents.

This separation allows the system to scale in complexity without tightly coupling UI, media transport, and intelligent processing.

---

## Host / Participant Model

mediaStage adopts a directed videoconference model based on explicit **host** and **participant** roles.

The **host** acts as the authoritative controller of the session. Rather than each participant freely managing their own view, the host determines what is visible, how it is arranged, and which transformations or tracking effects are applied. This model is particularly well suited for guided experiences, presentations, performances, or experimental setups where coherence and synchronization are critical.

Participants, on the other hand, primarily consume the experience defined by the host. Their clients receive layout decisions, visibility rules, and transformation parameters through the shared state mechanism, ensuring that all viewers perceive a consistent and synchronized representation of the session.

---

## Python Agents and Distributed Intelligence

A defining characteristic of mediaStage is its use of **independent Python agents** connected directly to LiveKit rooms. These agents are not embedded services but autonomous processes, each with a focused responsibility.

### Shared State Synchronization Agent

One dedicated agent is responsible for maintaining the **global shared state** of a session. This state represents the authoritative description of the experience and includes information such as:

- The active layout and its parameters
- Which participants are visible or hidden
- Which tracking or interaction modes are enabled
- Session‑wide composition decisions

The agent ensures that all connected clients converge to the same state, resolves conflicts, and propagates updates in a consistent and deterministic manner. This mechanism is fundamental to guaranteeing that all participants remain synchronized despite network variability or client‑side differences.

---

### Tracking Agents

mediaStage supports specialized agents dedicated to real‑time tracking and signal extraction.

Currently, the system includes a **hand‑tracking agent** implemented in Python. This agent detects the position and movement of users’ hands and publishes tracking events into the corresponding LiveKit room.

On the frontend, React components subscribe to these events and translate them into visual transformations, such as dynamic zooming within the browser. The design is intentionally generic, allowing additional trackers (e.g. gaze, body pose, facial expressions) to be integrated with minimal architectural changes.

---

### Persistence and Analysis Agent

Another agent is dedicated to **consistent and synchronized data persistence**. Its role is to record multimodal session data, including:

- User pose
- Gaze direction
- Active layout and composition state

By capturing these signals in a temporally coherent manner, the system enables both real‑time decision‑making and post‑session analysis. This data can later be used to study user behavior, optimize layouts, or train machine learning and AI models.

---

## Web Interface and Frontend Architecture

The web interface is built using **Next.js**, which serves both as the frontend framework and as the backend for session orchestration, authentication, and token generation.

The UI is composed of reusable **React components**, most notably:

- **MediaStage**, responsible for visual composition and rendering. It applies layouts, transformations, and visual effects based on the shared state.
- **MediaControls**, which expose interaction and control capabilities to the host and, where appropriate, to participants.

This component‑based approach allows the visualization logic to remain declarative, reactive, and closely aligned with the underlying shared state.

---

## Host Capabilities

The host is granted comprehensive control over the session. These capabilities include the ability to select and dynamically change layouts, manage individual or global audio states, control participant visibility, and apply tracking effects to specific users.

In practice, the host can mute or unmute individual participants, mute or unmute all users with a single action, show or hide video streams, expel users from the session, and decide which participants are affected by tracking‑based interactions such as hand‑driven zoom.

This centralized control model ensures that the session remains coherent and aligned with the host’s intent at all times.

---

## Business Logic and Session Management

From a business and organizational perspective, mediaStage is structured around **Spaces** and **Sessions**.

A **Super Admin** manages Spaces, which represent logical containers for activity. Each Space can host multiple Sessions. Within a Session, roles are defined, including the host and the participants.

For each session, the system generates a unique access token that routes users to their corresponding web experience. Hosts are authorized to create and delete sessions within their assigned Spaces.

Session creation also triggers the automatic generation of a calendar event and a unique URL, which is distributed to participants via email. This tight integration between session management, scheduling, and access control simplifies coordination and reduces operational friction.

---

## Authentication and Identity

Authentication is based on **OAuth**, currently supporting Google and GitHub as identity providers. Thanks to LiveKit’s ecosystem, additional OAuth providers can be integrated with minimal effort.

Next.js handles authentication flows, user management, and secure token issuance, acting as the backend gateway for all identity‑related operations.

---

## Media Handling and Optimization

### Audio

mediaStage places a strong emphasis on high‑quality audio. The system is configured with a relatively high audio bitrate and intentionally minimizes the use of aggressive filters such as noise suppression and echo cancellation.

This configuration prioritizes natural sound reproduction and low latency, making the platform suitable for scenarios involving music, nuanced audio content, or critical listening.

---

### Video

Video distribution leverages **dynacast** and **multicast** capabilities to adapt efficiently to heterogeneous network conditions. Resolution and bandwidth usage are dynamically adjusted, allowing the system to remain robust even under unstable connections.

Each participant may provide their own media source, which the host can selectively include or exclude from the composed experience.

---

## Layout System

The platform currently supports **grid** and **pin** layouts, which can be selected and modified by the host in real time. The layout system is designed to be extensible, enabling the future introduction of adaptive or AI‑driven layouts that respond to user behavior, tracking signals, or contextual cues.

---

## Future Directions

Looking ahead, mediaStage is designed to evolve toward more advanced synchronization and collaborative scenarios. Planned explorations include the use of **LiveKit Egress** for precise flow synchronization, recording, and analysis.

One envisioned direction is the enablement of tightly synchronized collaborative music or performance scenarios, where participants can observe and evaluate the combined result in real time. Additionally, the growing collection of pose, gaze, and interaction data opens the door to deeper AI‑driven insights and adaptive experiences.
# Start up

At aws instance:

```bash
cd /home/ubuntu/portable-amp/server/
sudo docker compose up -d
```

# mediaStage / Portable AMP - Architecture Diagram

## 1. High-Level System Architecture

```mermaid
graph TB
    subgraph ClientBrowser["Client Browser"]
        OAuth["NextAuth / OAuth<br/>(Google, GitHub)"]
        LKClient["LiveKit Client<br/>(livekit-client)"]
        ReactApp["React 19 / Next.js 15<br/>App Router"]
    end

    subgraph NginxProxy["Nginx Reverse Proxy :443"]
        Nginx["HTTPS Termination<br/>WebSocket Upgrade<br/>Path-based Routing"]
    end

    subgraph NextJS["Next.js Backend :3000"]
        APIRoutes["API Routes"]
        AuthAPI["/api/auth/*<br/>NextAuth"]
        TokenAPI["/api/token<br/>LiveKit JWT"]
        SessionAPI["/api/sessions/*<br/>CRUD"]
        InviteAPI["/api/invites/*"]
        AgentAPI["/api/setupAgent"]
        PrismaClient["Prisma ORM"]
    end

    subgraph LiveKitServer["LiveKit Server :7880"]
        Rooms["WebRTC Rooms"]
        DataChannels["Data Channels<br/>(state / cmd / chat)"]
        MediaTransport["Audio/Video<br/>SFU Transport"]
    end

    subgraph Agents["Python Agents (Docker)"]
        SharedStateAgent["Shared State Agent<br/>(JSON Patch sync)"]
        ZoomAgent["Hand Zoom Agent<br/>(MediaPipe Hands)"]
        GazePoseAgent["Gaze & Pose Agent<br/>(MediaPipe Pose/FaceMesh)"]
    end

    subgraph DataStores["Data Stores"]
        MongoDB[("MongoDB :27017<br/>Users, Sessions,<br/>Spaces, Roles")]
        Redis[("Redis :6379<br/>LiveKit Cache")]
        SQLite[("SQLite<br/>Pose/Gaze Logs,<br/>Layout Snapshots")]
    end

    %% Client connections
    ClientBrowser -->|HTTPS / WSS| NginxProxy
    Nginx -->|HTTP| NextJS
    Nginx -->|WS| LiveKitServer

    %% Auth flow
    OAuth --> AuthAPI
    AuthAPI --> PrismaClient
    PrismaClient --> MongoDB

    %% Token flow
    LKClient -->|Request Token| TokenAPI
    TokenAPI -->|JWT| LKClient
    LKClient -->|WebRTC| Rooms

    %% LiveKit internals
    Rooms --> DataChannels
    Rooms --> MediaTransport
    LiveKitServer --> Redis

    %% Agent connections
    SharedStateAgent <-->|state topic| DataChannels
    ZoomAgent <-->|cmd topic| DataChannels
    ZoomAgent -->|Subscribe| MediaTransport
    GazePoseAgent -->|Subscribe| MediaTransport
    GazePoseAgent --> SQLite

    %% Session management
    SessionAPI --> PrismaClient
    AgentAPI -->|Trigger| Agents

    style ClientBrowser fill:#e1f5fe,stroke:#0288d1
    style NginxProxy fill:#fff3e0,stroke:#f57c00
    style NextJS fill:#e8f5e9,stroke:#388e3c
    style LiveKitServer fill:#fce4ec,stroke:#c62828
    style Agents fill:#f3e5f5,stroke:#7b1fa2
    style DataStores fill:#fff8e1,stroke:#f9a825
```

## 2. Frontend Component Hierarchy

```mermaid
graph TD
    RootLayout["RootLayout<br/>(app/layout.tsx)"]
    SessionWrapper["SessionWrapper<br/>(NextAuth Provider)"]

    subgraph Pages["Pages"]
        SignIn["/signin"]
        Dashboard["/dashboard"]
        HostPage["/host"]
        ParticipantPage["/participant"]
        PublishPage["/publish"]
        SpacesPage["/spaces"]
        AdminPage["/admin"]
    end

    subgraph LiveKitLayer["LiveKit Layer"]
        RoomContext["RoomContext.Provider"]
        SharedStateProvider["SharedStateProvider"]
    end

    subgraph HostView["Host View"]
        HostContent["HostContent"]
        MainStageH["MainStage"]
        MediaControls["MediaControls"]
        ParticipantList["ParticipantList"]
        FloatingChat["FloatingChat"]
    end

    subgraph ParticipantView["Participant View"]
        MainStageP["MainStageParticipant"]
        HandCrop["HandVideoCrop"]
    end

    subgraph Hooks["Custom Hooks"]
        useSharedState["useSharedState()"]
        useCmdBus["useCmdBus()"]
        useChatBus["useChatBus()"]
        useTrackByUser["useTrackByUser()"]
    end

    RootLayout --> SessionWrapper
    SessionWrapper --> Pages
    HostPage --> RoomContext
    ParticipantPage --> RoomContext
    RoomContext --> SharedStateProvider
    SharedStateProvider --> HostContent
    SharedStateProvider --> MainStageP

    HostContent --> MainStageH
    HostContent --> MediaControls
    HostContent --> ParticipantList
    HostContent --> FloatingChat
    MainStageP --> HandCrop

    HostContent -.->|uses| Hooks
    MainStageP -.->|uses| Hooks

    style Pages fill:#e3f2fd,stroke:#1565c0
    style LiveKitLayer fill:#fce4ec,stroke:#c62828
    style HostView fill:#e8f5e9,stroke:#2e7d32
    style ParticipantView fill:#fff3e0,stroke:#ef6c00
    style Hooks fill:#f3e5f5,stroke:#7b1fa2
```

## 3. Real-Time Communication Protocols

```mermaid
sequenceDiagram
    participant Host as Host Client
    participant LK as LiveKit Server
    participant SSA as Shared State Agent
    participant Part as Participant Client

    Note over Host,Part: === State Synchronization (topic: "state") ===

    Part->>LK: Connect to Room
    Part->>SSA: state/requestSnapshot
    SSA-->>Part: state/snapshot (full state)

    Host->>SSA: state/patch (JSON Patch + version)
    SSA->>SSA: Validate & Apply Patch
    SSA-->>Host: state/change (applied patch)
    SSA-->>Part: state/change (applied patch)

    Note over Host,Part: === Command Bus (topic: "cmd") ===

    Host->>LK: cmd/request {name: "mute", correlationId}
    LK-->>Part: cmd/request forwarded
    Part-->>LK: cmd/ok {correlationId, result}
    LK-->>Host: cmd/ok response

    Note over Host,Part: === Chat (topic: "chat") ===

    Host->>LK: chat message {from, text}
    LK-->>Part: chat message broadcast
    Part->>LK: chat message {from, text}
    LK-->>Host: chat message broadcast
```

## 4. Data Flow: Session Lifecycle

```mermaid
flowchart LR
    subgraph Auth["1. Authentication"]
        A1["User visits /signin"] --> A2["OAuth (Google/GitHub)"]
        A2 --> A3["NextAuth creates JWT"]
        A3 --> A4["User record in MongoDB"]
    end

    subgraph Create["2. Session Creation"]
        B1["Host opens /spaces"] --> B2["POST /api/sessions/create"]
        B2 --> B3["SessionDomain +<br/>SessionRole in DB"]
        B3 --> B4["POST /api/setupAgent"]
        B4 --> B5["Agents join<br/>LiveKit room"]
    end

    subgraph Join["3. Joining"]
        C1["User opens<br/>/host or /participant"] --> C2["GET /api/token"]
        C2 --> C3["LiveKit JWT<br/>generated"]
        C3 --> C4["Connect to<br/>LiveKit room"]
        C4 --> C5["Request state<br/>snapshot"]
        C5 --> C6["Render<br/>layout"]
    end

    subgraph Live["4. Live Session"]
        D1["Host changes layout"]
        D2["State patch sent"]
        D3["Agent validates<br/>& broadcasts"]
        D4["All clients update"]
        D1 --> D2 --> D3 --> D4
    end

    Auth --> Create --> Join --> Live

    style Auth fill:#e8f5e9,stroke:#2e7d32
    style Create fill:#e3f2fd,stroke:#1565c0
    style Join fill:#fff3e0,stroke:#ef6c00
    style Live fill:#fce4ec,stroke:#c62828
```

## 5. Agent Processing Pipeline

```mermaid
flowchart TD
    subgraph VideoInput["Video Input"]
        Track["Participant<br/>Video Track"]
    end

    subgraph ZoomPipeline["Hand Zoom Agent"]
        Z1["Subscribe to<br/>video stream"]
        Z2["Convert I420 → BGR"]
        Z3["MediaPipe Hands<br/>detection"]
        Z4["Smooth bounding box<br/>(EMA filter)"]
        Z5["Publish zoom event<br/>via cmd topic"]
    end

    subgraph GazePipeline["Gaze & Pose Agent"]
        G1["Subscribe to<br/>video stream"]
        G2["Downscale to 640px"]
        G3["MediaPipe Pose<br/>(33 landmarks)"]
        G4["MediaPipe FaceMesh<br/>(468 landmarks)"]
        G5["Extract gaze<br/>direction"]
        G6["Store in SQLite"]
    end

    subgraph SharedStatePipeline["Shared State Agent"]
        S1["Listen on<br/>state topic"]
        S2["Receive patch<br/>request"]
        S3["Validate version<br/>(optimistic lock)"]
        S4{"Version<br/>match?"}
        S5["Apply JSON Patch"]
        S6["Broadcast<br/>state/change"]
        S7["Unicast<br/>state/changeRefused"]
    end

    Track --> Z1 --> Z2 --> Z3 --> Z4 --> Z5
    Track --> G1 --> G2 --> G3 --> G4 --> G5 --> G6

    S1 --> S2 --> S3 --> S4
    S4 -->|Yes| S5 --> S6
    S4 -->|No| S7

    style VideoInput fill:#e1f5fe,stroke:#0288d1
    style ZoomPipeline fill:#fff3e0,stroke:#ef6c00
    style GazePipeline fill:#f3e5f5,stroke:#7b1fa2
    style SharedStatePipeline fill:#e8f5e9,stroke:#2e7d32
```

## 6. Database Schema (Prisma / MongoDB)

```mermaid
erDiagram
    User {
        String id PK
        String name
        String email UK
        String image
        String globalRole
        DateTime emailVerified
    }

    Account {
        String id PK
        String userId FK
        String type
        String provider
        String providerAccountId
    }

    Space {
        String id PK
        String name
        String ownerId FK
        DateTime createdAt
    }

    SpaceMember {
        String id PK
        String spaceId FK
        String userId FK
        String role
    }

    SessionDomain {
        String id PK
        String spaceId FK
        String title
        String roomName
        DateTime scheduledAt
        String status
    }

    SessionRole {
        String id PK
        String sessionId FK
        String userId FK
        String role
    }

    PendingMember {
        String id PK
        String spaceId FK
        String email
        String role
    }

    User ||--o{ Account : "has"
    User ||--o{ Space : "owns"
    User ||--o{ SpaceMember : "member of"
    User ||--o{ SessionRole : "assigned"
    Space ||--o{ SpaceMember : "has members"
    Space ||--o{ SessionDomain : "has sessions"
    SessionDomain ||--o{ SessionRole : "has roles"
    Space ||--o{ PendingMember : "pending invites"
```

## 7. Docker Deployment Architecture

```mermaid
graph TB
    Internet["Internet / Clients"]

    subgraph DockerHost["Docker Host (network: host)"]
        subgraph FrontEnd["Frontend Tier"]
            Nginx443["Nginx :443/:80<br/>SSL + Reverse Proxy"]
        end

        subgraph AppTier["Application Tier"]
            Webapp["Next.js Webapp :3000"]
        end

        subgraph RTCTier["Real-Time Tier"]
            LK["LiveKit Server :7880"]
            Ingress["LiveKit Ingress :8080<br/>(WHIP/RTMP)"]
        end

        subgraph AgentTier["Agent Tier"]
            SSAgent["shared_state agent"]
            ZAgent["zoom_agent"]
        end

        subgraph DataTier["Data Tier"]
            Mongo["MongoDB :27017<br/>(Replica Set)"]
            RedisDB["Redis :6379"]
        end

        subgraph SSL["SSL"]
            Certbot["Certbot<br/>Let's Encrypt"]
        end
    end

    Internet -->|HTTPS :443| Nginx443
    Nginx443 -->|/live → ws| LK
    Nginx443 -->|/* → http| Webapp
    Nginx443 -->|/ingress| Ingress

    Webapp --> Mongo
    Webapp --> LK
    LK --> RedisDB
    SSAgent <--> LK
    ZAgent <--> LK
    Ingress --> LK
    Certbot -.->|certs| Nginx443

    Internet -->|UDP 50000-60000| LK

    style FrontEnd fill:#fff3e0,stroke:#f57c00
    style AppTier fill:#e8f5e9,stroke:#388e3c
    style RTCTier fill:#fce4ec,stroke:#c62828
    style AgentTier fill:#f3e5f5,stroke:#7b1fa2
    style DataTier fill:#fff8e1,stroke:#f9a825
    style SSL fill:#e0f2f1,stroke:#00695c
```

## 8. Layout System

```mermaid
graph LR
    subgraph Layouts["Layout Modes"]
        Grid["Grid Layout<br/>Auto-columns<br/>based on count"]
        Pin["Pin Layout<br/>Full-screen pinned<br/>+ thumbnails"]
        Custom["Custom Layout<br/>Drag & drop<br/>(react-rnd)"]
    end

    subgraph SharedState["Shared State"]
        UI["ui.layout:<br/>grid | pin | custom"]
        Entities["entities[id]:<br/>visible, playback,<br/>layout {x,y,w,h,z}"]
    end

    subgraph Rendering["Rendering"]
        MainStage["MainStage Component"]
        VideoTile["VideoTile<br/>(per participant)"]
    end

    UI -->|grid| Grid
    UI -->|pin| Pin
    UI -->|custom| Custom

    Grid --> MainStage
    Pin --> MainStage
    Custom --> MainStage
    Entities --> VideoTile
    MainStage --> VideoTile

    style Layouts fill:#e3f2fd,stroke:#1565c0
    style SharedState fill:#e8f5e9,stroke:#2e7d32
    style Rendering fill:#fff3e0,stroke:#ef6c00
```

## 9. RBAC (Role-Based Access Control)

```mermaid
graph TD
    subgraph GlobalRoles["Global Roles"]
        Admin["Admin<br/>(ADMIN_EMAIL)"]
        HostGlobal["Host<br/>(Space Owner)"]
        UserGlobal["User<br/>(Authenticated)"]
    end

    subgraph SessionRoles["Session Roles"]
        HostSession["Host<br/>(controls layout)"]
        Participant["Participant<br/>(viewer)"]
    end

    subgraph Permissions["Permissions"]
        ManageSpaces["Manage All Spaces"]
        ManageUsers["Manage Users"]
        CreateSessions["Create Sessions"]
        ControlLayout["Control Layout"]
        MuteParticipants["Mute/Kick"]
        ViewStream["View Streams"]
        Chat["Send Chat"]
    end

    Admin --> ManageSpaces
    Admin --> ManageUsers
    Admin --> CreateSessions
    HostGlobal --> CreateSessions
    HostSession --> ControlLayout
    HostSession --> MuteParticipants
    HostSession --> ViewStream
    HostSession --> Chat
    Participant --> ViewStream
    Participant --> Chat

    style GlobalRoles fill:#e3f2fd,stroke:#1565c0
    style SessionRoles fill:#fce4ec,stroke:#c62828
    style Permissions fill:#e8f5e9,stroke:#2e7d32
```

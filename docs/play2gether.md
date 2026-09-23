# Play2Gether — Documentación técnica

Play2Gether es una funcionalidad de grabación coral sincronizada integrada en la plataforma Amplify. Permite al host (profesor/director) coordinar a todos los participantes de una sala LiveKit para que graben simultáneamente su voz, envíen las grabaciones al servidor y obtengan una mezcla final sincronizada con una pista de referencia.

---

## Índice

1. [Visión general](#1-visión-general)
2. [Arquitectura](#2-arquitectura)
3. [Estado compartido](#3-estado-compartido)
4. [Máquina de estados (fases)](#4-máquina-de-estados-fases)
5. [API REST](#5-api-rest)
6. [Hook `usePlay2GetherSession`](#6-hook-useplay2gathersession)
7. [Flujo del host](#7-flujo-del-host)
8. [Flujo del participante](#8-flujo-del-participante)
9. [Componentes UI](#9-componentes-ui)
10. [Sincronización (técnica clapboard)](#10-sincronización-técnica-clapboard)
11. [Mezcla con ffmpeg](#11-mezcla-con-ffmpeg)
12. [Almacenamiento](#12-almacenamiento)
13. [Seguridad y roles](#13-seguridad-y-roles)

---

## 1. Visión general

```
Host                              Participantes
────                              ─────────────
1. Abre sesión (configura)
2. Sube pista de referencia
3. [Opcional] Ensayo:
   · Reproduce referencia         · Escuchan y ajustan niveles de mic
   · Ve quiénes están listos      · Pulsan "I'm ready"
4. Lanza countdown (clapboard)    · Ven countdown
                                  · Oyen clap → graban mic
5. Espera subidas                 · Suben grabación al servidor
6. Ajusta ganancias por pista
7. Lanza mezcla (ffmpeg)
8. Reproduce resultado            · Oyen el resultado
9. Descarga mix.webm
```

---

## 2. Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│  Browser (Next.js / React)                               │
│                                                          │
│  usePlay2GetherSession (hook central)                    │
│   ├── Lee p2g desde shared_state (JSON Patch / LiveKit)  │
│   ├── Deriva phase (idle→done) con ticker 250ms          │
│   ├── Gestiona MediaRecorder (tap del track LiveKit)     │
│   ├── Gestiona Audio(reference) y Audio(result)          │
│   └── Expone métodos host.* y markReady()                │
│                                                          │
│  Play2GetherHostPanel.tsx   Play2GetherClientPanel.tsx   │
│   (draggable, solo host)     (overlay, todos)            │
└──────────────────────────────────────────────────────────┘
                │ fetch
┌──────────────────────────────────────────────────────────┐
│  Next.js API Routes  (app/api/play2gether/)              │
│                                                          │
│  POST   /session          crear sesión                   │
│  GET    /session?id=…     leer estado servidor           │
│  POST   /reference        subir pista de referencia      │
│  POST   /record           subir grabación participante   │
│  POST   /ready            marcar participante listo      │
│  DELETE /ready            desmarcar                      │
│  POST   /mix              lanzar mezcla ffmpeg           │
│  GET    /file/[sessionId]/[filename]  servir archivos    │
└──────────────────────────────────────────────────────────┘
                │ /tmp/play2gether/{sessionId}/
┌──────────────────────────────────────────────────────────┐
│  Sistema de ficheros (efímero)                           │
│   session.json          metadata y estado                │
│   reference.{ext}       pista de referencia              │
│   rec_{identity}.webm   grabación de cada participante   │
│   mix.webm              mezcla final                     │
└──────────────────────────────────────────────────────────┘
```

**LiveKit** no se usa para transmitir audio entre usuarios durante la grabación. Play2Gether aprovecha el track de micrófono ya publicado en LiveKit (sin pedir nuevos permisos) y lo graba en paralelo con `MediaRecorder`.

---

## 3. Estado compartido

Play2Gether almacena su estado bajo la clave `play2gether` del shared state de la sala (agente Python, JSON Patch). Solo el rol `teacher` puede escribir en esta ruta; los `guest` (participantes) la leen pero no la modifican directamente.

```ts
type P2GSharedState = {
  sessionId: string | null;
  referenceUrl: string | null;       // URL del archivo de referencia en el servidor
  countdownSecs: number;             // duración del countdown (default 5)
  recordingDuration: number;         // duración máxima de grabación en segundos (default 30)
  clapAt: number | null;             // epoch ms exacto en que comienza la grabación
  resultUrl: string | null;          // URL del mix resultante
  status: "idle" | "preparing" | "rehearsal" | "active" | "mixing" | "done";
  playRehearsal: boolean;            // host reproduce referencia durante ensayo
  playResult: boolean;               // host reproduce el resultado para todos
  referenceGain: number;             // ganancia de la pista de referencia en el mix (0–2)
};
```

El campo `status` vive en el shared state (sincronizado a todos en tiempo real). El campo `clapAt` es el timestamp absoluto de inicio de grabación: todos los clientes calculan su propio countdown y disparan el `MediaRecorder` exactamente en ese instante.

---

## 4. Máquina de estados (fases)

La **fase** (`P2GPhase`) se deriva en el cliente a partir de `status`, `clapAt` y el reloj local. No se almacena en el shared state.

```
idle
 │  host.openSession()
 ▼
preparing ──────────────────────── host.startRehearsal()
 │                                          │
 │  host.startCountdown()                   ▼
 │                                      rehearsal
 │◄──────────────────────── host.endRehearsal()
 ▼
 (shared status = "active", clapAt fijado)
 │
 ├─ now < clapAt              → countdown
 ├─ clapAt ≤ now < clapAt+dur → recording
 └─ now ≥ clapAt+dur          → uploading
                                       │
                         host.triggerMix() → mixing → done
```

| Phase | Descripción |
|-------|-------------|
| `idle` | Sin sesión activa |
| `preparing` | Sesión creada, configurando referencia |
| `rehearsal` | Ensayo: participantes escuchan y ajustan niveles |
| `countdown` | Cuenta atrás visible para todos |
| `recording` | MediaRecorder activo en cada cliente |
| `uploading` | Grabaciones enviándose al servidor |
| `mixing` | ffmpeg procesando en el servidor |
| `done` | Mix listo, host puede reproducirlo para todos |

---

## 5. API REST

Todos los endpoints requieren sesión autenticada (NextAuth). El body JSON se indica donde aplica.

### `POST /api/play2gether/session`

Crea una nueva sesión y devuelve su ID.

```json
// Request
{ "roomName": "sala-1", "countdownSecs": 5, "recordingDuration": 30 }

// Response
{ "sessionId": "uuid-v4" }
```

### `GET /api/play2gether/session?sessionId=…`

Devuelve el JSON completo de la sesión almacenado en el servidor (participantes subidos, listos, etc.).

```json
{
  "sessionId": "…",
  "participants": {
    "user-alice": { "file": "rec_user-alice.webm", "clapOffset": 0, "uploadedAt": 1714000000000 }
  },
  "ready": { "user-bob": true },
  "status": "uploading",
  …
}
```

### `POST /api/play2gether/reference`

Sube la pista de referencia del host (multipart/form-data).

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `sessionId` | string | ID de sesión |
| `audio` | File | Archivo de audio (cualquier formato) |

```json
// Response
{ "url": "/api/play2gether/file/{sessionId}/reference.webm" }
```

### `POST /api/play2gether/record`

Sube la grabación de un participante.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `sessionId` | string | ID de sesión |
| `participantId` | string | Identity LiveKit del participante |
| `clapOffset` | number | Ms desde inicio de grabación hasta el clap (siempre 0) |
| `audio` | File | Grabación WebM/Opus |

```json
// Response
{ "ok": true, "participantId": "user-alice" }
```

### `POST /api/play2gether/ready`

El participante se marca como listo durante el ensayo.

```json
// Request
{ "sessionId": "…", "participantId": "user-alice" }

// Response
{ "ok": true, "participantId": "user-alice" }
```

### `DELETE /api/play2gether/ready`

Desmarca al participante (p. ej. al resetear el ensayo).

```json
// Request
{ "sessionId": "…", "participantId": "user-alice" }
```

### `POST /api/play2gether/mix`

Lanza la mezcla ffmpeg. Solo el host (autenticado) debe llamar a este endpoint.

```json
// Request
{
  "sessionId": "…",
  "referenceGain": 0.5,
  "participantGains": {
    "user-alice": 1.2,
    "user-bob": 0.8
  }
}

// Response
{ "resultUrl": "/api/play2gether/file/{sessionId}/mix.webm" }
```

### `GET /api/play2gether/file/{sessionId}/{filename}`

Sirve archivos de audio con soporte de Range requests (streaming).

---

## 6. Hook `usePlay2GetherSession`

Centraliza toda la lógica de Play2Gether. Se llama desde cualquier componente dentro del `LiveKitRoom`.

```ts
const {
  p2g,               // P2GSharedState — snapshot del shared state
  phase,             // P2GPhase derivada
  countdown,         // segundos restantes en countdown (0 si no aplica)
  recordingProgress, // 0.0–1.0 durante recording
  uploading,         // true mientras se sube la grabación
  uploadDone,        // true si la subida fue exitosa
  uploadError,       // string de error o null
  retryUpload,       // reintentar la subida
  markReady,         // participante → marca listo en el servidor
  host: {
    openSession,        // crear sesión (configura countdown y duración)
    closeSession,       // cerrar y resetear sesión
    uploadReference,    // subir File/Blob como pista de referencia
    startRehearsal,     // cambiar status a "rehearsal"
    endRehearsal,       // volver a "preparing" y limpiar ready flags
    setPlayRehearsal,   // reproducir/parar referencia para todos (ensayo)
    startCountdown,     // fijar clapAt y cambiar status a "active"
    triggerMix,         // (gains) → lanzar mezcla, devuelve resultUrl
    setPlayResult,      // reproducir/parar el resultado para todos
    setReferenceGain,   // ajustar ganancia de referencia en shared state
  },
} = usePlay2GetherSession();
```

### Gestión de audio interna

El hook gestiona dos `HTMLAudioElement` de forma interna:

- **`referenceAudioRef`** — se crea cuando cambia `p2g.referenceUrl`. Durante `rehearsal + playRehearsal=true` se reproduce en loop. Durante `recording` se reproduce desde el desplazamiento correcto (`now - clapAt`).
- **`resultAudioRef`** — se crea cuando cambia `p2g.resultUrl`. Se reproduce/pausa en función de `p2g.playResult`.

Los componentes **no** deben crear sus propios elementos `<Audio>` para estos casos; el hook ya los gestiona.

### Grabación con MediaRecorder

Cuando `phase === "recording"`, el hook obtiene el track de micrófono de LiveKit sin pedir nuevos permisos:

```ts
const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
const rawTrack = pub?.track?.mediaStreamTrack;
const recorder = new MediaRecorder(new MediaStream([rawTrack]), {
  mimeType: "audio/webm;codecs=opus",
  audioBitsPerSecond: 64_000,
});
```

LiveKit continúa publicando el audio con normalidad; `MediaRecorder` graba en paralelo sin interferir.

Al pasar a `uploading`, el hook llama automáticamente a `doUpload()`, que envía el blob a `/api/play2gether/record`.

---

## 7. Flujo del host

El host interactúa exclusivamente a través de `Play2GetherHostPanel`. El panel es arrastrable (react-rnd) y se abre desde la barra lateral del componente `HostContent`.

### Paso 1 — Configurar

- **Countdown (s):** tiempo de cuenta atrás antes de la grabación (3–30 s, default 5).
- **Record duration (s):** duración máxima de grabación (5–180 s, default 30).
- Botón **Open Session** → crea la sesión en el servidor y pone `status = "preparing"`.

### Paso 2 — Pista de referencia (opcional)

- **File:** carga un archivo de audio existente (cualquier formato que acepte el navegador).
- **Record:** graba desde el propio micrófono del host en tiempo real.
- La pista se sube a `/api/play2gether/reference` y su URL se guarda en `p2g.referenceUrl`.
- Un reproductor de preescucha aparece al subir.

### Paso 3 — Ensayo (opcional)

Disponible solo si hay pista de referencia subida.

- **Start rehearsal** → `status = "rehearsal"`. Los participantes ven la pantalla de ensayo.
- **Play reference for all** → `playRehearsal = true`. El hook de cada participante reproduce la referencia en loop.
- El host ve un contador de participantes listos (polling cada 3 s al servidor) con sus identities.
- **End rehearsal** → limpia los `ready` flags en el servidor y vuelve a `status = "preparing"`.

### Paso 4 — Lanzar

- **Start Countdown** → calcula `clapAt = Date.now() + countdownSecs * 1000 + 800ms` y pone `status = "active"`. Todos los clientes inician su countdown.
- Durante `recording`, el host ve una barra de progreso y el contador de grabaciones recibidas (polling).
- Durante `uploading`, ve la lista de participantes que ya han subido.

### Paso 5 — Mixer & escuchar

Aparece en cuanto hay grabaciones disponibles (`phase === "uploading"` o `"done"`).

- **Gain sliders** (0 %–200 %, default 100 % para participantes, configurable para referencia):
  - Referencia: slider + `<audio controls>` de preescucha.
  - Cada participante: slider + `<audio controls>` de la grabación individual.
  - El gain de referencia se sincroniza al shared state con debounce de 300 ms.
- **Mix recordings** → llama a `triggerMix(participantGains)`, que:
  1. Pone `status = "mixing"` en shared state.
  2. Hace POST a `/api/play2gether/mix` con las ganancias.
  3. Al recibir `resultUrl`, pone `status = "done"` y guarda la URL.
- **Reproductor del resultado** con control de preescucha local.
- **Play for participants / Stop for participants** → `setPlayResult(true/false)`. El hook de cada participante reproduce o para el audio de resultado en sincronía.
- **Download mix** → descarga `play2gether-mix.webm` directamente desde el servidor.

---

## 8. Flujo del participante

El participante ve `Play2GetherClientPanel`, un overlay de pantalla completa que aparece automáticamente cuando `phase !== "idle"`.

| Fase | Lo que ve el participante |
|------|--------------------------|
| `preparing` | Spinner con mensaje "The host is preparing a recording session. Stand by…" |
| `rehearsal` | Mensaje dinámico según `p2g.playRehearsal`. Botón "I'm ready" → `markReady()`. Una vez pulsado muestra "You're ready!" (badge verde). |
| `countdown` | Número grande con cuenta atrás. Nota sobre la pista de referencia si existe. |
| `recording` | Indicador de micrófono pulsante en rojo + barra de progreso. |
| `uploading` | Spinner de subida → al completar, "Recording uploaded / Waiting for host to mix". |
| `uploading` (error) | Mensaje de error con botón "Retry upload". |
| `mixing` | Spinner "Mixing tracks…" |
| `done` | Icono de check. Cuando `p2g.playResult = true` se reproduce automáticamente el resultado. |

El participante **no puede controlar** la reproducción del resultado ni acceder al panel del host. El audio de resultado se activa exclusivamente por el campo `playResult` del shared state, controlado por el host.

---

## 9. Componentes UI

### `Play2GetherHostPanel`

**Archivo:** [components/Play2GetherHostPanel.tsx](../components/Play2GetherHostPanel.tsx)

- Wrapper `<Rnd>` con `dragHandleClassName="p2g-drag-handle"`, anclado al borde de `bounds="parent"`.
- Usa `usePlay2GetherSession()` y `useRoomContext()`.
- Hace polling a `/api/play2gether/session` cada 3 s durante `rehearsal`, `recording` y `uploading`.
- Los gains por participante son estado local (`useState`) y **no** se sincronizan en el shared state; solo se envían al servidor en el momento de la mezcla.

**Subcomponentes:**
- `GainSlider` — slider de ganancia (0–2) + reproductor de audio inline.
- `PhaseBadge` — badge de color por fase.
- `NumberField` — input numérico con label.
- `SectionTitle` — cabecera de sección.

### `Play2GetherClientPanel`

**Archivo:** [components/Play2GetherClientPanel.tsx](../components/Play2GetherClientPanel.tsx)

- Overlay `absolute inset-0 z-40` sobre la vista del participante.
- Retorna `null` cuando `phase === "idle"`.
- Estado local: `isReady: boolean` (se resetea automáticamente cuando `phase !== "rehearsal"`).
- **No** gestiona audio propio; todo el audio lo maneja el hook internamente.

### Integración en la sala

- **`HostContent.tsx`** — botón `<Music2>` en el sidebar abre/cierra el panel del host (`showP2G` state).
- **`MainStageParticipant.tsx`** — renderiza `<Play2GetherClientPanel />` cuando `joined === true`.

---

## 10. Sincronización (técnica clapboard)

El desafío central de la grabación coral es que todos los participantes empiecen a grabar exactamente en el mismo instante para que los audios queden alineados al mezclarse.

**Solución adoptada:** timestamp absoluto compartido (`clapAt`).

```
Host                               Participantes
────                               ─────────────
clapAt = Date.now()
      + countdownSecs * 1000
      + 800ms  ← margen de red

patchP2G({ clapAt, status: "active" })
                    ──────────────────►  Reciben clapAt en shared state

                                         setTimeout(() => {
                                           playClapSound();  // ruido corto
                                           startMediaRecorder();
                                         }, clapAt - Date.now())
```

- Los 800 ms de margen (`CLAP_BUFFER_MS`) permiten que el patch del shared state llegue a todos los clientes antes de que el timer dispare.
- El tick de 250 ms actualiza `countdown` y `recordingProgress` en la UI.
- `clapOffset = 0` para todos: la grabación comienza exactamente en el clap; no hay detección de pico.
- Si un cliente llega tarde (el patch llega después del `clapAt`), `offsetSec = Math.max(0, (now - clapAt) / 1000)` alinea la reproducción de referencia correctamente.

El sonido de clap se sintetiza con Web Audio API (ruido blanco de 80 ms con decaimiento exponencial):

```ts
function playClapSound(): void {
  const ctx = new AudioContext();
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-(i / ctx.sampleRate) * 100);
  }
  // … connect gain → destination, play, close ctx on ended
}
```

---

## 11. Mezcla con ffmpeg

**Archivo:** [app/api/play2gether/mix/route.ts](../app/api/play2gether/mix/route.ts)

### Comando generado

```
ffmpeg -y
  -i reference.webm                          # input 0: referencia
  -ss 0.000 -i rec_alice.webm                # input 1: alice (seek al clap)
  -ss 0.000 -i rec_bob.webm                  # input 2: bob
  -filter_complex "
    [0:a]volume=0.500[ref];
    [1:a]volume=1.200[p1];
    [2:a]volume=0.800[p2];
    [ref][p1][p2]amix=inputs=3:duration=longest:normalize=0[out]
  "
  -map [out]
  -c:a libopus -b:a 128k
  /tmp/play2gether/{sessionId}/mix.webm
```

### Parámetros clave

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| `volume` | 0.0–2.0 | Ganancia por pista (referencia: `referenceGain`; participante: `participantGains[id]`, default 1.0) |
| `amix duration` | `longest` | El mix dura lo que la pista más larga |
| `normalize` | `0` | Sin normalización automática de volumen (el host controla manualmente) |
| `-c:a libopus` | — | Codec de salida: Opus |
| `-b:a 128k` | — | Bitrate de salida |

### Alineación

El flag `-ss {seekSec}` antes de cada input de participante recorta el audio hasta el punto del clap. Dado que `clapOffset = 0`, en la práctica no se recorta nada, pero la estructura permite soportar detección de clap futura sin cambiar el API.

---

## 12. Almacenamiento

Los archivos se guardan en `/tmp/play2gether/{sessionId}/`. Este directorio es **efímero** (se pierde con el reinicio del servidor).

```
/tmp/play2gether/
└── {sessionId}/
    ├── session.json          # metadata completa de la sesión
    ├── reference.webm        # pista de referencia (extensión preservada)
    ├── rec_{identity}.webm   # grabación de cada participante
    └── mix.webm              # resultado final
```

El archivo `session.json` actúa como base de datos ligera. Se actualiza en cada operación con `writeSession()`:

```ts
interface Play2GetherSession {
  sessionId: string;
  roomName: string;
  createdAt: number;
  countdownSecs: number;
  recordingDuration: number;
  referenceFile: string | null;
  participants: Record<string, {
    file: string;
    clapOffset: number;
    uploadedAt: number;
  }>;
  ready: Record<string, boolean>;
  resultFile: string | null;
  status: "preparing" | "recording" | "uploading" | "mixing" | "done" | "error";
}
```

Para producción se recomienda sustituir `/tmp` por almacenamiento persistente (S3, NFS, volumen Docker).

---

## 13. Seguridad y roles

| Acción | Requiere | Cómo |
|--------|----------|------|
| Crear sesión | Autenticado | `getServerSession` en todos los endpoints |
| Escribir shared state (`/play2gether/*`) | Rol `teacher` | Agente Python rechaza patches de `guest` |
| Subir referencia | Autenticado | Endpoint valida sesión NextAuth |
| Subir grabación | Autenticado | Endpoint valida sesión NextAuth |
| Marcar listo | Autenticado | `/api/play2gether/ready` valida sesión |
| Lanzar mezcla | Autenticado | Endpoint valida sesión NextAuth |
| Controlar reproducción | Solo host | `setPlayResult` / `setPlayRehearsal` patchean shared state → solo `teacher` puede hacerlo |
| Descargar mix | Autenticado | Ruta de archivo con sesión (sin auth en GET actualmente — añadir si necesario) |

Los participantes con rol `guest` **leen** el shared state en tiempo real pero no pueden modificarlo. Toda su interacción con el servidor se hace a través de los endpoints REST, que solo permiten operaciones acotadas (subir grabación propia, marcar listo).

Play2Gether — Demo Script
1 · The problem (15s)
"Real-time choral singing over the internet is impossible — network latency is in the hundreds of milliseconds, so participants can never sync musically. Play2Gether solves this by treating the call as a coordination channel, not a performance channel. Everyone records locally, perfectly aligned, and the server stitches the takes together afterwards."

2 · Host walkthrough (60s)
"I open the Play2Gether panel from the sidebar — it lands centered on screen, draggable. Notice the help panel on the right (toggle with the ? icon): it walks any new host through the steps, starting with the most important point — everyone must wear headphones, otherwise the videoconference audio leaks into the recordings."

"Step 1: I set the countdown and recording duration."

"Step 2: I upload a reference track — this is the base every participant records on top of. It's not optional; it's what gives the takes a shared timeline."

"Step 3 is rehearsal — I play the reference for everyone so they can level their mics. Each participant taps 'I'm ready'."

"Step 4: I pick who records. By default it's everyone, but I can target a single participant — useful for redoing a bad take. I hit Start Countdown."

3 · Participant experience (30s)
"On the participant side, an overlay takes over: a big countdown number, then a pulsing red mic and a progress bar during recording. After the duration ends, their recording uploads to the server automatically. If they're not the target of a single-participant round, they see a passive 'Alice is recording…' panel instead — they know to stay quiet."

4 · The sync trick (45s)
"Here's the clever part. When I hit Start Countdown, the host doesn't tell anyone 'start now' — it broadcasts an absolute timestamp through LiveKit's shared state: clapAt = now + countdown + 800 ms. Every client schedules a local setTimeout to that exact moment. At clapAt, two things happen on each client simultaneously:"

"First, the browser plays a synthetic clap through the speakers — that's the audible signal."

"Second, the same clap is injected directly into the MediaRecorder's audio graph, so it lives inside the recording as a permanent acoustic sync marker. ffmpeg uses that marker later to trim every take to the same t=0."

"No NTP, no clock drift handling — just one shared timestamp and a recoverable marker baked into the audio itself."

5 · Mixer & new features (60s)
"After uploads, the mixer appears. Each take has a volume slider, an inline preview player, and a trash icon to delete a bad take before mixing. I adjust gains, hit Mix recordings, and ffmpeg blends everything with the reference track using amix."

"What's new: the session no longer closes after mixing. I can re-mix as many times as I want with different gains, or launch another countdown to re-record any participant — even before the first mix. So the workflow becomes iterative: record, listen, fix one person's take, mix again, until I'm happy."

"Finally I hit Play for participants to broadcast the result through everyone's browser, or Download to get the final mix.webm."

6 · Wrap-up (15s)
"Under the hood: LiveKit for the call and shared state, MediaRecorder per client for the local capture, a Next.js API + ephemeral /tmp storage for uploads, and ffmpeg for the mix. The whole feature is gated by the teacher role — participants can only upload their own take. Questions?"



Resumen de la sincronía para tontos
🕰️ Problema: queremos que todos los coristas empiecen a grabar exactamente en el mismo instante, pero internet no entrega nada instantáneamente y los relojes de los portátiles pueden estar descuadrados.

🪛 Trucos que usamos:

Ningún reloj del usuario es el árbitro — el servidor sí. Al abrir Play2Gether, cada navegador "pinga" al servidor 5 veces midiendo cuánto tarda el ida-y-vuelta. Con eso calcula cuántos milisegundos va adelantado o atrasado su reloj respecto al del servidor. Eso es el offset. Por ejemplo: el portátil de Bob va 1.2 segundos adelantado → offset = -1200.

El host no dice "empezad ya", dice "empezad a las 14:30:05.800 del servidor". Cuando pulsa Start Countdown, el navegador del host calcula esa hora futura usando su propio offset y la escribe en el estado compartido de LiveKit. Es solo un número grande.

Cada cliente convierte esa hora del servidor a su propio reloj local. Alice, cuyo reloj coincide con el servidor (offset=0), hace 14:30:05.800 - 0 = 14:30:05.800. Bob, adelantado 1.2s, hace 14:30:05.800 - (-1200) = 14:30:07.000 en SU reloj local. Cada uno ya sabe en qué instante de SU reloj tiene que actuar.

setTimeout es el despertador del navegador. Le decimos: "despiértame dentro de N milisegundos" (donde N es ese instante futuro menos Date.now() ahora mismo). Aunque cada cliente pida tiempos numéricos distintos, los despertadores suenan a la misma hora de pared real, porque cada uno se calculó relativo al reloj propio.

Cuando suena el despertador, el navegador en una sola acción: arranca el MediaRecorder, mete un "clap" sintético en la grabación, y lo reproduce por los altavoces para que el cantor sepa que ya está.

Si la red va muy lenta y el patch tarda más de los 800 ms de margen en llegar, el delay calculado sale negativo: ese cliente ya llega tarde. Lo descartamos en silencio en lugar de meter una grabación medio empezada que descuadre el mix.

Buena pregunta, esa es la parte clave. La técnica se llama algoritmo de Cristian (lo que hace NTP por debajo, en versión simplificada). La idea: medir el "viaje completo" hasta el servidor y asumir que ida y vuelta tardan más o menos lo mismo.

Una medición, paso a paso

cliente                                  servidor
  │
  │ t1 = Date.now()                          (apunto la hora local justo antes)
  │
  │ ─── GET /api/play2gether/time ──►
  │           (~100 ms en la red)
  │                              ┌─────────────┐
  │                              │ serverNow = │  (el servidor mira su reloj
  │                              │ Date.now()  │   y lo mete en la respuesta)
  │                              └─────────────┘
  │ ◄── { now: serverNow } ───
  │           (~100 ms en la red)
  │
  │ t2 = Date.now()                          (apunto la hora local justo al recibir)
  ▼

rtt = t2 - t1
Tengo tres números:

t1 → mi reloj cuando envié
t2 → mi reloj cuando recibí
serverNow → reloj del servidor en algún punto entre t1 y t2
El truco geométrico
No sé exactamente cuándo del intervalo [t1, t2] el servidor leyó su reloj. Pero si asumo que la ida y la vuelta tardaron lo mismo, fue justo en el punto medio:


cuando_servidor_leyo_su_reloj ≈ t1 + rtt/2
Eso ocurrió en mi reloj a las t1 + rtt/2. Y a esa misma hora el servidor leyó serverNow. Así que la diferencia entre los dos relojes es:


offset = serverNow - (t1 + rtt/2)
Y a partir de ahí, en cualquier momento posterior:


hora_servidor_ahora ≈ Date.now() + offset
Ejemplo con números
Supón que t1 = 1000000 ms y mi reloj va atrasado 40 ms respecto al servidor:


t1         = 1000000   (mi reloj al enviar)
serverNow  = 1000150   (servidor recibe la petición 110 ms después
                        y mira su reloj — está 40 ms adelantado y
                        han pasado 110 ms de red, total +150)
t2         = 1000220   (mi reloj al recibir, 220 ms después)

rtt        = 1000220 - 1000000          = 220
medio      = 1000000 + 220/2            = 1000110
offset     = 1000150 - 1000110          = +40

→ "el servidor va 40 ms adelantado respecto a mí"
Si ahora quiero saber qué hora es en el servidor, hago Date.now() + 40.

Por qué hacemos 5 muestras
El supuesto "ida y vuelta tardan igual" se rompe si la red está congestionada en una dirección (por ejemplo, una llamada Zoom satura tu upload pero el download va fino). En ese caso una sola medición da un offset sesgado de decenas o cientos de ms.


results.sort((a, b) => a.rtt - b.rtt);
const bestHalf = results.slice(0, Math.ceil(results.length / 2));
bestHalf.sort((a, b) => a.offset - b.offset);
return bestHalf[Math.floor(bestHalf.length / 2)].offset;
Hacemos 5 pings.
Descartamos los 2-3 con RTT más alto (más sospechosos de tener latencia asimétrica).
De los 2-3 con RTT más bajo, devolvemos la mediana de sus offsets — robusta a un outlier suelto.
Con eso, normalmente acabamos con un error de offset por debajo de los 10 ms aunque la red tenga jitter.

Lo que NO arregla
No corrige drift en vivo: si tu reloj se desincroniza durante la sesión (raro, pasaría centenares de ms por hora en el peor caso), el offset queda obsoleto. Si fuera crítico, se re-mediría cada X minutos.
No protege contra relé NAT raro donde la red sea sistemáticamente asimétrica en cada llamada — pero eso es muy poco común.
Para Play2Gether es más que suficiente: la sesión dura minutos, no horas, y la asimetría real en navegadores residenciales sobre LiveKit es de pocos ms.

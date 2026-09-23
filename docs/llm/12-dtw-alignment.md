# DTW alignment — measuring the take instead of a proxy for it

`scripts/p2g_dtw_align.py`, `app/api/play2gether/align/route.ts`, and `AlignRow`
/ `DriftSpark` in `components/Play2GetherHostPanel.tsx`.

Read this before changing the band, the feature, or the statistic. All three
have been wrong once already, and two of them were wrong in ways that looked
right.

## The third quantity

Three things now measure the same misalignment, and they are not copies of each
other:

| | measures | when | human in the loop |
|---|---|---|---|
| calibration round (doc 10) | the **device** round trip | before anyone plays | none |
| sync round (doc 11) | device **+ the player against a click** | before the take | the player, anticipating |
| this | **the take itself**, against the audio it was performed over | after the take exists | the performance, as it happened |

Only the third observes the thing being corrected rather than a proxy for it.
That is its whole claim, and it is a strong one: the take was recorded while the
player listened to the reference, so whatever their monitoring path cost them is
already baked into the audio. DTW reads it back out.

It also produces something neither of the others can: **drift**. A player who
starts 130 ms late and ends 90 ms late has no single correct offset, and until
now nothing in the system could see that.

## The arithmetic, once

The mix places a take at `netDelay = captureDelayMs − manual` after the
reference's t=0 (`mix/route.ts`). An event that sits at reference time `T`
appears in the take file at `t = T + lag`, where `lag` is what DTW reports. In
the mix it lands at `netDelay + t`, so:

```
captureDelayMs − manual + T + lag  =  T      ⟺      manual = lag + captureDelayMs
```

`summarise()` does that addition and reports `offsetMs`, so the UI never has to.
**If you change one side of this, change the other** — the same warning doc 11
carries about its own derivation.

## What testing found, 2026-09-03

The starting point was a 25-line script from the host that worked. Three things
were wrong with it, and the first is the interesting one.

### 1. The forced endpoints contaminate the mean

Classic DTW must match the first frame to the first and the last to the last, so
both ends of the path carry an offset that was **imposed rather than measured**.
On the first field pair the leading path offsets were literally `[0. 0. 0. 0. 0.]`
and the take's true lag was ~130 ms, so the mean was dragged toward zero:

```
raw mean                       -123.7 ms
trimmed 10 % each end          -133.8
trimmed 20 % each end          -135.3      ← the take aligned by hand said 135
```

Fixed twice over: the path now has **free ends** (start and finish wherever the
cost is lowest, within the band), and `summarise` still trims 10 % and takes a
**median**, not a mean.

Free ends are also a correctness fix, not a refinement. A take is routinely
LONGER than the reference — `recordingDuration` rounds the song up and the
capture runs a tail past it — and classic DTW simply cannot terminate when the
two lengths differ by more than the band. A 31 s take against a 30 s reference
refused outright, blaming the band. Both cases now measure: a longer take, a
take that stopped early, and the original pair all return the same 121.9 ms.

### 2. The answer has a ±15 ms uncertainty, not ±5

The warping path snaps to whole frames, so every reported lag is an integer
multiple of the hop. Sweeping the parameters on one pair:

```
hop 512 (23.2 ms)   -112 … -134       hop 128 (5.8 ms)   -128 … -142
hop 256 (11.6 ms)   -128 … -129       hop  64 (2.9 ms)   -125 … -135
```

So the honest statement is **around −128 ms with about ±15 of method
uncertainty**, and the hop is now 128 (5.8 ms/frame). Do not promise better.

### 3. librosa cannot ship on the server, and does not need to

`librosa.sequence.dtw` allocates the **full N×M cost matrix even when a band is
requested** — measured: memory is identical for `band_rad` 0.25 and 0.02. For a
five-minute take:

```
hop 512 → 1.34 GB        hop 256 → 5.3 GB        hop 128 → 21.4 GB
```

The banded implementation here allocates only the band, and the within-row
"left move" chain — the obvious Python loop, and the entire runtime when written
that way — is solved exactly as a prefix minimum:

```
cur[k] = C[k] + min_{l≤k}(base[l] − C[l]),    C = cumsum(cost)
```

which is `np.minimum.accumulate`. Measured on a five-minute pair: **3.3 s wall,
238 MB peak**, and the peak is in the STFT (chunked), not the DTW.

**And librosa was not what made the numbers good.** Its `onset_strength` is
reproduced here to the millisecond by `_mel_flux`; what mattered was the *mel
filterbank*, which is twelve lines:

```
flux, linear frequency   -116.1 ms   MAD 23.2
flux, mel filterbank     -127.7 ms   MAD 11.6
chroma from the STFT     -127.7 ms   MAD 11.6
librosa onset_strength   -127.7 ms   MAD 11.6      ← identical to mel flux
librosa chroma_cqt       -359.9 ms   MAD 487.6     ← the only one that failed
```

Linear bins pile resolution into the top octaves, where two different
instruments have least in common. The one feature librosa provides that this
cannot — `chroma_cqt` — was the only one that did not work on the material
tested. On that evidence, putting librosa on the server buys nothing.

## The failure mode, which is the same one doc 11 has

**On periodic material the path can slide by a whole beat or bar at no cost, and
it comes back confident.** This is not a different problem from the sync round's
beat aliasing; it is the same problem in a different algorithm.

Demonstrated accidentally, and the demonstration is worth keeping. To measure the
five-minute cost, a 6 s clip was tiled fifty times — i.e. a perfectly periodic
signal:

```
band ±0.5 s, no centre       lag +34.8 ms    MAD 185.8    drift range 354 ms
band ±0.2 s, centred on 130  lag +127.7 ms   MAD  75.5    drift range  29 ms
```

Wide and uncentred, it is garbage. Narrow and centred on the calibration figure,
it is right. Real music is less periodic than a tiled loop, but bars and loops
are exactly what music is made of, so treat the tiled case as the shape of the
risk rather than a curiosity.

Hence the two defences, both borrowed from `searchWindow` in `syncDetect.ts`:

- **`--expect` centres the band on the calibration figure** (falling back to the
  sync offset, then to 0). As there, it is never used as a *value* — only to
  choose which of several candidate alignments a beat apart is the plausible
  one, which is a question a ±50 ms estimate answers comfortably.
- **The band is narrow**: ±0.25 s when a centre is known, ±0.5 s when it is not.
  If a lag and that lag ± one beat both fit inside the band, the answer is not
  unique. A beat at 120 BPM is 500 ms, so ±0.25 s is the widest that is safe
  there, and slower music is safer still.

`madMs` is the quality indicator, and the UI colours on it and never on the
offset — same rule as the sync card. A path that never settled is a take with no
single correct slider position, and no amount of nudging fixes that.

## The fixtures, and what they settled

`scripts/p2g_dtw_fixtures.py`, built the same day and for the same reason
`p2g_sync_fixtures.py` exists: the only way to know an alignment is right is to
build material whose answer you already know.

The reference is always a backing track — pad chords on a I–vi–IV–V, kick, hat,
bass at 100 BPM. A take is always **one other instrument** playing along, which
is what a P2G mic actually records: shared musical structure, almost no shared
spectrum. Thirteen cases, scored twice, because blind and centred are the two
ways the product actually calls it.

```
  melflux blind     4 good   5 fair   3 bad   1 refused
  chroma blind      3 good   4 fair   5 bad   1 refused
  melflux centred   7 good   3 fair   2 bad   1 refused      ← the product's setting
  xcorr             2 good   4 fair   7 bad   0 refused
```

(good = within 25 ms of truth, fair = within 60.)

### It does beat cross-correlation, and where

The caveat this section used to carry — that the one real pair tested did not
separate DTW from the envelope correlation rejected in doc 11 — is retired. It
did not separate them because it was one easy pair. Given material with the
properties musicians actually have, they separate immediately:

```
                              truth      DTW centred      xcorr
G_pluck_expressive_130         +130       +104.5         -499.2
H_voice_expressive_130         +130       +133.5         +539.9
I_pluck_drift_160_to_80        +120       +121.9         -493.4
```

Those three are ±35–45 ms of per-note human timing, and a lag that ramps across
the take. Correlation needs the whole envelope to line up rigidly, so expressive
timing does not degrade its peak, it *moves* it — to a different beat entirely.
This is doc 11's rejection of content matching being right about correlation and
wrong about DTW, and it is worth being precise about which.

### A wrong answer does not look confident, and that is checked

The property that decides whether this is safe to show a host. From the scorer,
on the product's own setting:

```
worst error among results with MAD ≤ 40 ms : 25.5 ms
lowest MAD among results wrong by > 60 ms  : 52.2 ms
```

There is a gap, and the UI's soft/hard threshold sits inside it. **The scorer
prints both numbers on every run; if they ever cross, the threshold has stopped
separating anything and has to move.** Do not change the feature, the band or
the statistic without re-running it.

### Three defects the fixtures found

- **Chroma was sharing the onset window, and that was mush.** At `NFFT = 1024`
  the bins are 21.5 Hz apart while a semitone down at A2 is about 4 Hz, so every
  low note landed in the same bin. STFT chroma scored **1 of 13**. With its own
  4096-point window (and log magnitude rather than power, so the loudest partial
  cannot decide the frame's pitch class) it scores 3 good / 4 fair — and it now
  measures `C_pad`, the no-transients case that melflux structurally cannot.
- **Silence returned a confident number** (+203 ms). The same failure doc 10
  records for calibration ("a silent take used to return a confident 182 ms").
  Now refused, on the RMS of the audio rather than on the feature — a take of
  nothing but hum has plenty of amplitude and no structure.
- **The reference bleeding into the mic beats the player**, which is doc 11's
  click-bleed trap transposed. Fixture `K`: player at 130 ms, reference bleeding
  back at 60 ms at −6 dB, and the aligner reports **+63.9** — it measured the
  bleed, which is machine-perfect and has no human term in it. A player
  monitoring on speakers cannot be measured this way either. The MAD flags it
  (52.2), but the number itself is wrong for a reason no amount of tuning fixes.

### What it measures worst

`E_voice` — legato, soft attacks, vibrato — is the hardest realistic case and
the one bad answer that is not an artefact: +209 against a truth of 130, MAD
52.2. Weak onsets give melflux little to work with and a moving pitch gives
chroma little either. If a singer's alignment looks odd, that is the case you
are in, and the sync round or the slider is the better tool.

## Why it is manual, and why it does not seed

The host presses a button per take. Nothing calls it automatically and nothing
seeds the mixer from it.

That is not timidity. The other two measurements survive because they fail
**visibly** — a refused sync round says so, an unmeasured player sits obviously
late. This one's failure mode is a confident number a beat out, which is the one
kind of wrong that a silent automatic correction turns into a mystery. A number
somebody pressed a button for is a number they look at.

The result is stored under `alignments[takeKey]` — keyed by the **take**, not the
person, unlike `calibOffsets` and `syncOffsets`, because it describes a
performance. `takeFile` records which one, and the row offers a re-run instead of
a stale number when the take has been re-recorded.

## Features: which to use

- **`melflux`** (default) — onsets. Use when the take and the reference share
  RHYTHM: percussion, plucked strings, anything with an attack.
- **`chroma`** — pitch-class energy, L2-normalised, invariant to timbre by
  construction. Use when they share HARMONY: voice, keys, bass. Useless for
  unpitched percussion.

Both are numpy. They do NOT share a window — chroma has its own 4096-point one,
for the reason under the fixtures above. On the one real pair tested they agree
(121.9 vs 127.7 ms); on the fixture set melflux is clearly the stronger default
(4 good against 3, and 3 bad against 5, run blind), and chroma earns its place on
exactly one case: material with no transients at all, which melflux cannot see.

## Where this runs, and why it is the one thing in the tree that needs python

The webapp image is `node:24.12-alpine`. It had ffmpeg and no python, so the
first real deploy of this feature failed with `spawn python3 ENOENT` — a message
that sends whoever reads it looking at the audio. The route now says what it
actually means, and the Dockerfile installs `python3 py3-numpy`.

**Alpine's prebuilt numpy, not pip.** On musl there is no numpy wheel, so
`pip install numpy` builds from source: gcc, gfortran, openblas-dev, several
minutes of build and hundreds of megabytes. `apk add py3-numpy` from the
community repo is ~40 MB of already-compiled package, and the node images have
that repo enabled.

**And this is meant to be temporary.** A second runtime in a Node image, for
exactly one feature, is a real cost — it is ~90 MB, it pins numpy to whatever
the Alpine release ships, and it keeps a whole class of failure (a missing
binary, a subprocess timeout, parsing another process's stdout) that in-process
code does not have. The three ways out, in the order they should be considered:

1. **Port the analyser to TypeScript** — the end state. It needs an FFT, the mel
   filterbank, the flux and chroma features and the banded DTW: about 400 lines,
   no new dependency, in-process, and `syncDetect.ts` is the precedent for DSP
   in TS here. The reason it has not been done yet is sequencing, not doubt:
   this feature is validated on synthetic fixtures and one real pair, so porting
   it now would be investing four hundred lines in something that has not yet
   earned its place. **The fixtures make the port checkable** — score the TS
   implementation over the same manifest and every case must land where the
   python one does — so when it happens it is verifiable rather than hopeful.
2. **A separate python service.** Rejected. `server/agents/*` already carries
   python and numpy, but those are LiveKit agent workers rather than an HTTP
   service, and the analyser needs the session's files on disk. That means
   inventing an internal API, an auth story and a shared volume, for no gain
   over either of the other two.
3. **Delete it.** If real takes say DTW does not hold up between different
   instruments, the script, the route, the button and the Dockerfile line all
   come out together. That is a real possible outcome and it is why option 1 is
   waiting.

## Running the fixtures

```
python3 scripts/p2g_dtw_fixtures.py /tmp/dtwfix --score
```

Thirteen cases, about a minute. Read the two numbers under "does a wrong answer
ever look confident" before anything else; the table is for seeing *which* case
moved.

## Still open

The fixtures answer the question in the negative direction — they can show that
a method fails, and three of them did. They cannot show that synthetic
instruments are what real ones do. Additive synthesis has cleaner onsets, no
room, no bleed except the one that is deliberately injected, and a player who is
statistically well-behaved even when jittered.

So the honest state is: **cross-instrument alignment works on synthetic
cross-instrument material, and on one real pair.** What is still missing is real
takes of real instruments over a real reference — which is exactly what the next
session produces. Run both features on them, check against the calibration
figure, and add any case that surprises you to the fixture set, which is what
that file is for.

Until then this stays a third opinion the host asks for, which is the weight the
evidence supports.

## Re-recording a take used to inherit its predecessor's number (2026-09-04)

Reported from the field as *"when you record someone again there is no way to
compute the DTW"*, and the missing button was the symptom of something worse.

Take keys and filenames are **reused**. Delete take 1 and the next upload takes
the freed slot: same key (`participantId`), same `rec_<name>.ogg`. The stored
alignment was invalidated by comparing `alignment.takeFile` against the take's
filename, so after a delete-and-re-record the two matched, the row decided the
number was still current — and the row only offers the Align button when it has
nothing to show. So the host saw a confident DTW figure measured from audio that
no longer existed, and no way to measure the take that did.

Fixed on both sides, because they fail differently:

- **The server drops the alignment with the take.** `DELETE /record` deletes
  `meta.alignments[participantId]`, and a new upload deletes whatever was stored
  for the slot it lands in. This is the fix that also cleans up sessions that
  are already wrong.
- **The row's staleness test is now the take's upload time**, not its name: an
  alignment `measuredAt` before the take's `uploadedAt` cannot be about that
  take, whatever either is called. Filenames were always a proxy for this.

## The caveats are one line, not four paragraphs (2026-09-04)

The result row carried four stacked explanations — drift, soft MAD, search edge,
measured blind — about sixty words under a single number, on every take. In the
mixer that pushes the next strip off screen, and a host working a ten-take round
skips it for exactly that reason.

Each is now two or three words on one line (`drifts 80 ms · soft ±52 · blind`)
with the full previous text in its `title`. Nothing was deleted, and the ranking
is deliberate: worst first, amber for the three that mean *do not trust this
number*, grey for `blind`, which only means it could be better.


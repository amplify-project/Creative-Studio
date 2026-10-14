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

~~So the honest state is: cross-instrument alignment works on synthetic
cross-instrument material, and on one real pair.~~ Superseded 2026-10-13 by
real material — see "Real takes, and the echo test" below. Short version: it
works on voices, it does NOT work between two instruments that share little
(and now says so), and the MAD was the wrong confidence measure all along.

This stays a third opinion the host asks for — but it is now one that refuses
when it did not measure.

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

## Real takes, and the echo test (2026-10-13)

`scripts/p2g_real_bench.py`, `scripts/p2g_bleed.py`, `tests/python/test_bleed_and_echo.py`.

### The benchmark

The "Still open" above asked for real takes with a known answer. Dagstuhl
ChoirSet (Rosenzweig et al., TISMIR 2020, CC-BY 4.0) recorded every singer of a
vocal quartet on their own larynx microphone, simultaneously — so leave one
singer out, use the other three as the reference, delay the one by a known lag,
and the answer is exact. 13 quartet takes × 4 singers × (full ~145 s, two 40-s
excerpts) × (clean, with bleed) = **296 cases**. Plus a real cross-instrument
pair: the jazz trio's keys and guitar stems (`testAudio/keyRef.wav` and
`gtRef.wav` are exact cuts of `KeyStem`/`GtStem` from 120.064 s).

```
python3 scripts/p2g_real_bench.py build ../datasets/dcs/DagstuhlChoirSet /tmp/bench
python3 scripts/p2g_real_bench.py score /tmp/bench        # ~30 min, all methods
python3 scripts/p2g_real_bench.py echo  /tmp/bench        # the echo test only
```

The data is not in the repo (≈1 GB of LRX tracks from Zenodo record 4607766;
range requests work, so only the files needed have to be fetched).

### What it found — three things the synthetic fixtures could not show

**1. On voices it works.** Choir, no bleed, centred: melflux 121/148 within
25 ms and none off by more than 60; chroma about the same. The pulse grid is the
WORST method here (Locus Iste is slow and rubato): centred, 24 of 148 answers off by > 60 ms,
some flagged `clear` while 456 ms out.

**2. The MAD separates nothing on real material.** A *correct* choir answer has
a median MAD of 64 ms (melflux; p90 81). The UI's `soft = madMs > 40` called
295 of 296 real results soft, and the dangerous answers below often had a LOW
MAD. The threshold was set on additive-synthesis fixtures, whose onsets are
cleaner than any voice.

**3. The answer can be the centre it was given.** On the jazz pair, moving
`--expect` from truth−75 to truth+75 moved the answer **64 → 203 ms** (melflux)
and 35 → 325 (chroma): the DTW was handing back the calibration figure. With a
single centred run that is invisible — the bench's own first version centred
+25 ms off the truth, so an echo scored as a ✓. On choir, melflux follows the
centre by ~23 % and chroma by ~0 %.

### The echo test

So the analyser now centres the band twice, at `expect − 50` and `expect + 50`:

```
echo = (lag₊ − lag₋) / 100           0 = it measures, 1 = it returns the centre
answer = (lag₋ + lag₊) / 2           the midpoint cancels a partial pull
```

`ECHO_MAX = 0.5`: on choir a right answer echoes 0.12–0.46 (p10–p90), on the
jazz pair 0.99–1.45. It costs a second DTW (the features are computed once).

### Bleed: found, removed, and used as the centre

The reference leaking into the mic is fixture K's trap. On the first version of
this benchmark — bleed at −12 dB and a fixed 60 ms, i.e. **70 ms away from the
player** — raw chroma was right in 0 of 148 choir cases and melflux wrong by
> 60 ms in 63. That separation turned out to be the unrealistic part (see
"Where the bleed really is" below); the numbers in this section's table come
from that version, the results further down from the realistic one.

But the bleed is the file we played, so `p2g_bleed.py` finds it exactly:
GCC-PHAT gives a needle at its delay (to the sample — 60.00 ms in every case),
where a different instrument playing along gives a broad hump. Three gates,
set on the bench (154 cases with bleed, 154 without, choir + jazz):

| gate | with bleed | without |
|---|---|---|
| PSR ≥ 10 | 32 – 602 | 3.6 – 47 |
| uniqueness ≥ 2 (peak / next peak) | 5.9 – 74 | median 1.2 |
| block agreement ≥ 0.6 | 0.88 – 1.0 | median 0 |
| **all three** | **154/154 found** | **3/154 false** |

Without the last two, PSR alone flagged 31 clean takes: crosstalk in the
dataset (the other singers' larynx mics hear the left-out one, so the reference
contains them — at the singer's own lag) and mains hum, which correlates as a
comb of equal peaks every 10 ms. Real takes from the July session, all on
headphones, scored PSR 3.8–7.

It is then subtracted: a least-squares FIR over the bleed's lag −1…+5 ms,
fitted per 16-s block. Frequency-domain Wiener was tried first and made takes
WORSE — wherever the reference is quiet the division amplifies the player.
Fewer taps and longer blocks lower the floor (the part of the player the filter
also removes): 17.7 → 24.2 dB on a real take. A real speaker in a room has a
tail longer than 5 ms; that is untested.

And two guards on what is left, because both features are scale-free:

- **Mask.** In the player's rests the residue — 15–20 dB under the bleed —
  reads as music as loud as the player (melflux is log-spectral, chroma is
  normalised per frame). A synthetic take cleaned to 37 dB against the player
  still answered 17 ms for a player at 130. So bins where the cleaned take is
  under (removed bleed − 15 dB) contribute no flux, and such chroma frames are
  zero vectors. NOT a floor shaped like the bleed: that floor has the bleed's
  onsets in it, and the first version put them straight back (49 ms).

#### Where the bleed really is — and the rule that had to go (2026-10-14)

A first version also REFUSED any answer within ±20 ms of the bleed's lag
(`verdict: "bleed"`): on the 60-ms benchmark all 26 chroma failures on cleaned
takes sat there. The first real session with bleed (`testAudio/p2g_keys121`,
keys over a full mix, **on headphones**, leaking at −28…−32 dB) showed why that
is backwards: a player in time with what they hear lands in the take at the
device round trip, which is **exactly where the bleed lands**. Bleed at
128.6 / 132.6 / 128.0 ms, players at ~125–136 by every method — the rule refused
three right answers.

So the rule is gone and the bleed's lag became the **search centre**
(`centreFrom: "bleed"`, band ±0.25 s), ahead of the calibration figure: it is
the round trip measured on this very take, to a tenth of a millisecond — on
keys121 it even showed the latency jumping 10 ms mid-take, which a calibration
round taken beforehand cannot see. The benchmark now puts the bleed at
truth − feel, feel cycling −25 / −10 / +10 / +25 ms (`p2g_real_bench.py`,
`BLEED_FEEL_MS`).

A take that IS a copy of part of the reference is indistinguishable from bleed
and will be removed as bleed. No player does that; a `?p2gtest` track cut from a
stem that is also in the reference would.

### The result, on the product's own setting

`p2g_dtw_align.py` with its defaults (bleed removal + bleed centre + echo +
mask), calibration figure 25 ms off, realistic bleed (−12 dB at truth − feel):

```
                      melflux                         chroma
choir, no bleed       123 ✓  25 ~   0 ✗              123 ✓  22 ~   3 ✗
choir, bleed          133 ✓  15 ~   0 ✗              135 ✓  13 ~   0 ✗
"measured" verdicts   276/296, worst error 44 ms     292/296, two wrong (worst 121)
bleed detection       147/148 found at its lag ±1 ms; 3/148 clean takes flagged
jazz keys/guitar      1 of 12 "measured" (35 ms); every answer off by > 60 ms is flagged
synthetic fixtures    centred 9/1/2 (was 7/3/2); the one "measured" > 60 ms is E_voice
```

Honest comparison: with REALISTIC bleed the old single centred run was not the
disaster the 60-ms benchmark suggested — melflux 121 ✓ 27 ~ 0 ✗ — because a
bleed sitting near the player pulls the answer toward roughly the right place.
The gain from bleed handling there is 121 → 133 within 25 ms. The gain that
matters more is the echo test (the jazz pair) and dropping the MAD rule.

**One floor, only after debleeding.** A floor relative to the file's maximum
(librosa's `top_db = 80`) was tried on every take and cost the synthetic
fixtures 7/3/2 → 5/6/1 centred and 4/4/4 → 0/1/11 blind — the jump out of true
silence is part of what the onset feature measures. On a cleaned take it is
what keeps the residue down (choir with bleed: 104 → 127 ✓). So
`TOP_DB_AFTER_BLEED` applies only when bleed was removed.

**What the echo cannot see: a stable wrong minimum.** Blind on the synthetic
set, `H_voice_expressive` answers −278 ms off, `measured`, at both centres —
half a beat at 100 BPM. The DTW is measuring, just the wrong alias. That is the
beat-aliasing problem of doc 11/15, and the echo test is not an answer to it;
the `blind` flag stays.

`verdict` replaces the MAD as the UI's colour: `measured | follows-centre |
band-edge`, worst first (`bleed` existed briefly; see above). Alignments stored before it fall back to the
MAD rule. "Agrees with DTW" on the pulse grid now requires `measured` — a DTW
that returned the calibration figure, beside a grid centred on the same figure,
agrees by construction.

### Still open after this

- **Two instruments that share little** (keys vs guitar): the DTW does not
  measure, and now says so; the pulse grid centred gets 6/6. Nothing in this
  file fixes that.
- **Fast tempo** (the July session, 183 BPM): every method is ambiguous a beat
  apart. Beat This! on the take as well, matching downbeats, is tried in doc 15
  ("Downbeats on the take"): it fixes the alias at normal tempo and fails where
  the model cannot find bars in a single instrument.
- **Chroma's stuck zero.** A take recorded with the browser's speech filters
  on (`testAudio/martain/rec_martainnskene.wav`) gives chroma exactly 0.0 at
  both centres, MAD 35 — `measured`, and wrong. Melflux flags it.
- **A real speaker.** All bleed here was a pure digital delay. Record one take
  with the reference on laptop speakers before trusting the 5-ms filter.


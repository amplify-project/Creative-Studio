## HOWTO

###  depends on: 

- ingress server
- lk cli
- redis-server
- livekit-server


#### Ingress server:
```bash
sudo docker run --rm     -e INGRESS_CONFIG_BODY="`cat config.yaml`"     -p 1935:1935     -p 8080:8080     --network host     livekit/ingress
```
```yaml
#config.yaml
log_level: debug
api_key: devkey
api_secret: secret
ws_url: ws://localhost:7880
redis:
  address: localhost:6379
```
#### Redis-server

```bash
sudo docker run -p 6380:6379 redis:7

```

#### Livekit-server

Install:

```bash
curl -sSL https://get.livekit.io | bash
```
Run:

```bash
livekit-server --dev --redis-host localhost:6379
```
Default user/pass: devkey secret

#### lk cli

- Create room: lk room create Name
- List ingress: lk ingress list
example:
```bash
┌─────────────────┬───────┬───────────┬──────────────┬─────┬────────────────┬─────────────────────────────────────────────────────┐
│ IngressID       │ Name  │ Room      │ StreamKey    │ URL │ Status         │ Error                                               │
├─────────────────┼───────┼───────────┼──────────────┼─────┼────────────────┼─────────────────────────────────────────────────────┤
│ IN_DQVKWyQxhCvX │ rgbd2 │ test      │ JWZhUA9bRYgU │     │ ENDPOINT_ERROR │ i/o timeout                                         │
│ IN_iHdLpk7x55ee │ rgbd  │ i7i1-v0o4 │ ssBqQwDvLBXP │     │ ENDPOINT_ERROR │ timed out while waiting for ICE candidate gathering │
└─────────────────┴───────┴───────────┴──────────────┴─────┴────────────────┴─────────────────────────────────────────────────────┘
```
- Create ingrees: lk ingress create ingress.json

```json
{
    "input_type": 1,
    "name": "rgbd2",
    "room_name": "test",
    "participant_identity": "rgbd1-whip",
    "participant_name": "rbgd1"
}
```
#### Publish by whip

- You need streamkey, for example: JWZhUA9bRYgU
- Whip URL: http://localhost:8080/w/JWZhUA9bRYgU

```bash
sudo docker exec gst-whip gst-launch-1.0 filesrc location=/tmp/video.mp4 !   decodebin name=d d. ! videoconvert !   videoconvert !   x264enc tune=zerolatency speed-preset=ultrafast bitrate=8000 !   rtph264pay config-interval=1 pt=97 !   'application/x-rtp,media=video,encoding-name=H264,payload=97,clock-rate=90000' !   whip.sink_0 whipsink name=whip whip-endpoint="http://localhost:8080/w/JWZhUA9bRYgU"
```

## TODO

- Used by https in order to used outside dev mode.


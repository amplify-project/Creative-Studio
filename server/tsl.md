## Use own TLS

## Generate certs

```bash
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout livekit.key \
  -out livekit.crt \
  -config livekit-tls.conf \
  -extensions v3_req
```

## Config

```bash
sudo cp livekit.crt /usr/local/share/ca-certificates/livekit.crt
sudo update-ca-certificates
```

NOTE: gstreamer not allow to ingress with self-signed certificate, use http

```bash
sudo docker exec gst-whip gst-launch-1.0   filesrc location=/tmp/video.mp4 !   qtdemux name=demux   demux.video_0 !   h264parse config-interval=1 !   rtph264pay pt=97 !   'application/x-rtp,media=video,encoding-name=H264,payload=97,clock-rate=90000' !   whip.sink_0   whipsink name=whip whip-endpoint="http://192.168.10.180:8080/w/SsRpdviGsqJ6"
```

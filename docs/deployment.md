# Deployment

AMPLIFY PORTABLE is a user-friendly digital tool designed to unite people across distances for learning, performing, and creating together. Ideal for community settings, it combines AI-driven audio-visual production with phygital engagement, making collaborative experiences seamless and accessible.


---

## Configuration

Copy [`.env.example`](../.env.example) to `server/.env` and fill it in for your deployment. The variables that decide where everything lives:

```
NODE_IP=192.168.1.25
NEXT_PUBLIC_NODE_IP=${NODE_IP}
NEXT_PUBLIC_LIVEKIT_URL=wss://${NODE_IP}/live
LIVEKIT_URL=ws://${NODE_IP}:7880
LIVEKIT_API_KEY=<your key>
LIVEKIT_API_SECRET=<your secret>
```

---

## Installation

### Requirements

- Docker
- Docker Compose

Install the services via Docker:

- LiveKit server  
- Ingress server  
- Redis  
- Calibration agent server  
- Web frontend & backend  
- Nginx proxy  

```bash
cd server
sudo docker compose up -d
```

This project uses UDP ports 50000–60000 and TCP ports 443, 7880, 6379, 8080, 3000.

---

## Browser Access

The URL is:  
https://localhost

---

## Deployment

To publish multimedia content, it is recommended to use an ingress with Docker using the official LiveKit and GStreamer image, a docker-compose.yaml can be found at utils folder. Once gstreamer docker is running it can be used at bellow example:

```
cd utils
sudo docker compose up -d
```

Example:

```bash
docker exec gst-whip gst-launch-1.0 \
    filesrc location=/tmp/video.mp4 ! \
    qtdemux name=demux \
    demux.video_0 ! \
    h264parse config-interval=1 ! \
    rtph264pay pt=97 ! \
    'application/x-rtp,media=video,encoding-name=H264,payload=97,clock-rate=90000' ! \
    whip.sink_0 \
    whipsink name=whip whip-endpoint="http://192.168.10.180:8080/w/zoMhToYudbhT"
```

Configure the room and inputs for LiveKit:

```bash
cd server
chmod +x configRoom.sh
./configRoom.sh
```

Copy the table generated to know the `streamKey` where to publish. Example:

```
IngressID       Name    Room      StreamKey      URL     Status                Error  
IN_TrEw2xmTCVnQ rgb1    test      8XXTg95xHB9t         ENDPOINT_PUBLISHING  
IN_Rfi9A74WitKw rgb2    test      TxuZnvha3pww         ENDPOINT_PUBLISHING  
IN_6543Gj67uc6X rgb3    test      guNUpNvBCMhD         ENDPOINT_ERROR      i/o timeout  
IN_Lzbef9razvwn rgbd2   test      SsRpdviGsqJ6         ENDPOINT_PUBLISHING  
```

StreamKey is the key to publish to your room via WHIP. For example, the URL for rgb1 would be:  
https://192.168.10.180/ingress/w/8XXTg95xHB9t


---

## Notes

- Ensure the LiveKit server is accessible at the defined URL.  
- Adjust the server/.env variables according to your environment.  
- For more information about LiveKit, visit https://livekit.io

---

## Generating the LiveKit keys

The API key pair in `server/.env` must match `server/server.yaml`. Generate a
fresh pair per deployment — never reuse another install's:

```bash
docker run --rm livekit/livekit-server generate-keys
```

TLS material (`certs/`, `server/nginx/certs/`, `server/livekit.key`) is also
per deployment and is not kept in this repository.

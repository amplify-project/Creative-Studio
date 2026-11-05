FROM python:3.11-slim

# DejaVu: the visualisation needs a font with accents (viz.py)
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Data-only agent: no OpenCV / MediaPipe, so no libgl and plain dependency
# resolution (the other agents use --no-deps with a fully pinned list).
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python3","-u","agent.py","start"]

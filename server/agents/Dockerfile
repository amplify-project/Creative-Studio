FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt --no-deps


# Copiar el agente
COPY . .

CMD ["python3","-u","zoom_agent.py","start"]

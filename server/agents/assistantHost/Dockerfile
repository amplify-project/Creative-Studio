FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt --no-deps

COPY . .

CMD ["python3", "-u", "assistant_host.py", "start"]

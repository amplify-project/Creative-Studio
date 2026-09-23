import os
import json

class LayoutLogger:
    def __init__(self, path: str, buffer_size: int = 0):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.file = open(path, "w", buffering=1)
        self.buffer = []
        self.buffer_size = buffer_size

    def store(self, snapshot: dict):
        try:
            self.buffer.append(snapshot)

            if len(self.buffer) >= self.buffer_size:
                self.flush()

        except Exception as e:
            # Nunca lances la excepción hacia arriba
            # El agente NO debe caerse por logging
            import logging
            logging.exception(
                "LayoutLogger.store failed. Snapshot keys=%s",
                list(snapshot.keys()) if isinstance(snapshot, dict) else type(snapshot)
            )

    def flush(self):
        for s in self.buffer:
            self.file.write(json.dumps(s) + "\n")
        self.buffer.clear()

    def close(self):
        self.flush()
        self.file.close()
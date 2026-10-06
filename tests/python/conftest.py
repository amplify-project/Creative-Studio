"""Make the agents' modules importable the way their containers see them:
each agent runs from its own directory, which is first on sys.path."""
import sys
from pathlib import Path

AGENTS = Path(__file__).resolve().parents[2] / "server" / "agents"
for d in (AGENTS / "shareState", AGENTS / "assistantHost"):
    sys.path.insert(0, str(d))

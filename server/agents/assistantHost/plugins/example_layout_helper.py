"""
example_layout_helper — reference plugin showing the full plugin shape.

It does one thing: when the host is in `pin` layout and there are more
than three visible participant cameras, suggest switching back to grid
so the thumbnails don't get too small to recognise faces.

Use this file as a starting point: copy it, rename the class, change
the body of `on_state`, edit `name` / `description`, drop it next to
this file. The host will pick it up on next restart.
"""

from __future__ import annotations
import logging
import os
from creativestudio_assistant import AssistantPlugin, PluginContext
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s.%(msecs)03d %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("assistant_host:example_plugin")


class LayoutHelper(AssistantPlugin):
    name = "layout-helper"
    description = "Suggests grid layout when pin mode is hosting too many cameras."
    max_per_minute = 2  # this plugin should be quiet; one nudge is enough

    def __init__(self, ctx: PluginContext):
        super().__init__(ctx)

    async def on_state(self, state: dict) -> None:
        # Extraemos el payload, si no existe, usamos el state directamente por si cambia la estructura
        logger.info("DATO RECIBIDO COMPLETO EN ON_STATE: %s", state)
        
        # Ahora buscamos ui y entities DENTRO del payload
        ui = state.get("ui") or {}
        entities = state.get("entities") or {}
        layout = ui.get("layout")
        pinned = ui.get("pinnedVideo")

        # Count visible entities. The layout_snapshot payload the host
        # emits doesn't carry a `kind` field, so we can't filter by camera
        # type here — every visible tile competes for stage space, which is
        # what this nudge cares about.
        cams = [
            e
            for e in entities.values()
            if isinstance(e, dict) and e.get("visible", True)
        ]
        count = len(cams)

        logger.info(
            "number of videos showing: %d, current layout: %s, pinned: %s",
            count,
            layout,
            pinned,
        )
        # Trigger: pin layout with many cameras competing for space — the
        # side strip of thumbnails gets too small to be useful, so suggest
        # grid. We don't require `pinned` to be set: the layout_snapshot
        # payload doesn't carry pinnedVideo, so it'd suppress the nudge.
        if layout == "pin" and count > 3:
            await self.ctx.suggest(
                title=f"{count} cameras in pin mode — switch to grid for a clearer view?",
                description="With this many cameras, grid layout makes everyone equally readable.",
                skill="stage.layoutGrid",
                args={},
                dedup_key="layout-helper:too-crowded-for-pin",
                ttl_ms=20000,
            )

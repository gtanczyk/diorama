---
name: diorama-story
description: Author or revise Diorama game stories with simple NPC progress, conditional dialogue, optional walks and event-triggered travel. Use for Diorama Studio story work and its generation pipeline, including additions to existing worlds.
---

# Diorama stories and NPC progress

Use the repository's `docs/npc-motion.md` for the current flags/effects format, examples, extension limits and asset follow-up. In this project-local skill it is at [NPC story stages, walking and travel](../../../docs/npc-motion.md). Read [Studio](../../../docs/studio.md) for the world-editing workflow. For source changes, the shared authoring instructions live in `app/src/story/npc-guidance.ts` and are consumed by the new-story designer, extension designer and Studio agent.

Keep NPC progress as simple as the story needs: “waiting for the key → key received → in the garden.” Use ordinary NPC-prefixed flags, `when` branches and event effects. Earlier requests must stop matching after progress changes. `at:place` means the player's location; relocated NPC locations are stored in `state.npcs`. A flag alone does not relocate a person.

Walking is optional per character. A stationary NPC can change dialogue as the story develops. A purposeful repeated walk uses `patrols`; a single trip uses `moveNpc` in an interaction or dialogue choice. There is no minimum number of moving characters. Preserve the creator's scope when they request only a simple stage change.

For game-world edits through Studio:

- Read `world_status` and `story_status` for the target world. Use `story_redo` with the requested stages, event and response changes; `story_text` only changes wording. Use the available Diorama MCP actions so edits appear in History and survive rebuilds. Do not hand-edit generated world files.
- Distinguish the editor's `npc_move` standing-position correction and `cast_animate` asset preparation from story-driven walking. Declare a travelling NPC once, use existing connecting exits, and author destination dialogue with the same character key.
- `world_extend` adds content while preserving existing NPC stages, flags and motion. Use new names for added flags, including negative conditions. A requested change to an existing NPC belongs to the story-editing workflow.
- After a story job finishes, inspect checker issues and needed assets. New walkers may need model/sprites; new lines need voices/faces; visual object changes need plates. Reuse suitable existing assets. Follow jobs with `job_wait`, then `play_reload` after success.
- Use `playthrough` for the authored progression, and inspect source dialogue before/after the event and destination dialogue. Cover return travel when present. Report whether visual walking was observed: a still frame or a successful build does not prove the sequence works.

For generator or pipeline edits, keep the shared instructions consistent across fresh stories and extensions, retain additions-only merge protections, and run checks appropriate to the behaviour changed. Do not start paid world generation merely to validate instructions.

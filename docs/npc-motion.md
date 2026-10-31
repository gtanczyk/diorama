# NPC story stages, walking and travel

Movement is part of `story.json`. Existing stories keep their stationary NPCs until movement is authored. The story designer can add purposeful patrols; Studio's `story_redo` can request patrols and moves triggered by puzzles or dialogue choices. The Story view displays patrols and travel effects.

## Simple story stages

A character needs only the progress the story uses. For example, a gardener can wait for a key, receive it, then go to the garden. Use ordinary flags with the NPC's key as a prefix and `when` conditions:

| Stage | Dialogue condition | Event that advances it |
| --- | --- | --- |
| Waiting for the key | `["!gardener-key-received"]` | Giving the key sets `gardener-key-received` |
| Key received, still inside | `["gardener-key-received", "!gardener-outside"]` | A goodbye choice sets `gardener-outside` and moves the gardener |
| In the garden | `["gardener-outside"]`, dialogue in `garden` | The same NPC thanks the hero there |

The event's effects do the work. For example, giving the key can use `[{"take":"garden-key"},{"set":"gardener-key-received"}]`; the departure choice can use `[{"set":"gardener-outside"},{"moveNpc":{"npc":"gardener","to":"garden"}}]`. The key needs an item definition and a reachable way to obtain it. Both places and their connecting exit must already exist. Earlier dialogue branches stop matching after the event, so the NPC no longer asks for a key it has received. List specific branches before a fallback because the first matching branch wins. Use `once` for a one-time object interaction when appropriate.

Flags describe story progress. `state.npcs` records relocated NPCs' actual logical place; `at:place` tests where the player is. Setting a flag alone does not move anyone. Stages can change dialogue while the character stays in one spot. Each character's walking is optional, with no minimum number of moving NPCs and no separate goals or memory system to configure.

The authoring rules are shared by the new-story designer, extension designer and Studio agent in `app/src/story/npc-guidance.ts`. They describe the existing flags/effects schema; there is no additional NPC-stage generation step.

## Studio and rebuilds

Ask, for example: “The gardener waits for my key, thanks me after receiving it, and goes to the garden when I say goodbye. Keep them still until then.” The agent reads `story_status`, then uses `story_redo` for those behavioural changes. It uses `story_text` for wording alone. This rewrites the story and uses the normal model calls. `npc_move` in the place editor changes a standing position; it does not author a story event. `cast_animate` prepares animation assets; it does not give the character a walking route.

After the story job finishes, inspect its checker issues, conditional dialogue and effects. Prepare missing animation with model/sprites for newly walking characters, voices/faces for new spoken lines, and plates for visual object changes. Existing animation can be reused. Reload the game after successful jobs, then run `playthrough` and inspect the changed stages: old requests disappear, the event fires, and the NPC is available in the destination. Inspect a return trip too when authored. A place-motion sample or a passing build alone does not establish that the full sequence works.

For new worlds, the build reads the story before planning models, then uses derived scene geometry for sprites. For extensions, `world_extend` retains existing NPC dialogue, stages, flag names and patrol order, and adds optional stages/walks only for new NPCs. A new travelling NPC is declared only at its original place; its new destination dialogue can name that key. New effects must not change existing NPCs, flags or inventory. A request to change an existing NPC's progression belongs to `story_redo`, rather than an additions-only extension. The combined story is checked before the staged extension is installed.

## Walking within a place

Add an optional `patrols` array:

```json
{
  "patrols": [
    {
      "npc": "gardener",
      "place": "courtyard",
      "via": ["flower-bed", "well"],
      "when": ["!garden-ready"],
      "pause": 2
    }
  ]
}
```

`via` names two to eight fixed things in that place, with at least two different keys. The NPC walks to their approach spots in order, then repeats. `pause` is seconds at each stop (0.5–60, default 2). `when` uses the story's usual facts. The first matching patrol wins. An inactive patrol stops its walker. No patrol means the person stays put.

NPCs share the player's floor grid, obstacle routing, stairs, depth scaling and distance-driven walk cycle. Clicking a moving person stops them while the hero approaches; they remain still for their own speech and conversation, then resume. Hit testing and interaction distance follow their visible body. Positions are retained for the current game session when the hero changes places. Off-screen patrols pause; this does not depend on wall-clock time or introduce timed puzzles.

## Leaving after an event

An interaction's `do`, or a dialogue choice's `do`, can contain:

```json
{"moveNpc": {"npc": "gardener", "to": "garden"}}
```

The destination must be a neighbour of the NPC's current place, connected by an existing world exit. Declare the character in exactly one original place in `world.json`; do not add a second character in the destination. Destination dialogues and interactions may address the same key. The checker validates their availability and all endings with the NPC's changing location, including return trips. Use flags and `once` when an event must not repeat.

After the event's lines have finished, the NPC walks to the connecting exit. In the destination it enters at the exit leading back, then walks to its first patrol stop, original standing spot when returning home, or the scene start. A conversation still in progress holds its departure. The source hotspot disappears with the body, and only one clickable instance exists at the destination. If the hero leaves first, the departure completes off screen. Events affecting unseen NPCs work the same way. NPC travel uses world connections; the hero's inventory-based exit locks do not apply to NPCs.

The pure story state stores each relocated NPC's place under `state.npcs`, so story search and serialized states preserve its location. Visual walking is reconciled with that logical destination after speech. An unreachable physical exit produces a browser warning and holds the NPC in place; it does not teleport through an obstacle. Patrols skip unreachable stops after their pause. Check the actual scene's walk grid and play through authored movement.

For structured model output, the travel effect is `{"op":"moveNpc","key":"gardener","to":"garden"}`. Other effects retain their existing `{op,key}` representation.

## Animation assets

`diorama sprites <slug> --plan` includes NPCs with patrols or travel effects, even if they have no spoken lines, and plans their walking facings. Rebuild their model/sprites to obtain full walking animation. Until then, an older NPC with only talk sheets uses its existing 2D rig, model or cut-out while walking. No paid generation is required to use an already available rig or cut-out.

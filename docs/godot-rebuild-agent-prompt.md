# Godot Rebuild Agent Prompt

## Codebase Analysis Summary

The source project is `Belfast Commando` / `Belfast Survivor`: a fast first-person shooter built with Three.js, Vite, and Tauri v2. The current game loop is:

- `HUB`: a 3D Belfast safehouse with menu panels, a landline level-code system, story logs, settings, and a laptop black-market shop.
- `LEVEL`: first-person combat in a Belfast sector. The player clears all invaders, saves civilians, then reaches an extraction beacon.
- `RESULTS`: score, bonus breakdown, Resistance Points payout, retry/next/return choices, and campaign progression.

Important current mechanics to preserve:

- Movement: mouse-look, WASD, sprint stamina, jump, slide, health regeneration after a delay, mobile touch controls, gamepad support.
- Signature combat: kick-heavy FPS play. `F` kicks doors open, boots enemies, detonates barrels, breaks crates, triggers boot abilities, and is central to the game identity.
- Weapons: sidearm, boomstick, and SMG with magazines, reloads, hitscan raycasts, recoil/bob/sway, muzzle flash, bullet holes, blood decals, and weapon ownership gating.
- Enemy roster: grunt, gunner, enforcer, and breacher. The current implementation is melee-focused: grunts and gunners rush, enforcers are tanky and kick-resistant, and breachers serpentine and detonate.
- Level content: procedural Belfast terraced streets, interior breach rooms, kickable doors, roadblocks, murals, crates, explosive barrels, apartments, furniture, civilians, and a final vertical Divis Tower extraction.
- Campaign data: seven sectors in `src/data/levels.json`: Falls Road, Shankill, The Markets, The Docks, Ardoyne, Short Strand, Divis Tower. Each has a code, intro/outro, extraction point, par time, and escalating modifier chance.
- Progression: persistent Resistance Points, upgrades, equippable boots, weapon unlocks, achievements, redeemed level codes, unlocked level count, campaign index, and settings.
- Upgrades/boots: Kick Master, Thick Skin, Adrenaline Leak, Scavenger's Refund; Standard Issue, Semtex Soles, Greased Brogues, Hare's Hoofs.
- Modifiers: Rainy Night, Curfew, Adrenaline. These change friction, sight range, enemy counts, speed, and rewards.
- Civilians: rescuable NPCs can be menaced by captors, lose life, flee when saved, reward score/RP, and are tracked in the HUD.
- Atmosphere: damp night Belfast, cold fog, rain, low-poly/PS1 survival-horror treatment, nearest-filtered textures, vertex-jitter styling, persistent gore/impact decals, street lamps, murals, grimy interiors, and uneasy alliance storytelling.
- Story/theme: fictional invaders force an uneasy cross-community Belfast alliance. Ruairí and Davy represent opposed local factions who cooperate to defend civilians and liberate the city. Do not make real-world local communities the enemy.

Reusable assets live mostly in `public/`: GLB models, VFX sprites, textures, murals, UI art, loading art, music, ambient loops, and voice/SFX samples. Raw/source assets live under `assets/` and are gitignored/large-source oriented.

## Ready-To-Paste Prompt

You are a senior Godot 4.x game-development agent. Recreate and complete the existing Three.js game `Belfast Commando` from scratch in Godot, then expand it into a full original cooperative horde-shooter campaign inspired by the pacing and mechanics of Left 4 Dead while preserving the story, tone, setting, and signature mechanics of this Belfast game.

Important IP boundary: do not copy Valve/Left 4 Dead maps, level names, characters, dialogue, logos, audio, art assets, exact enemy names, or exact layouts. Use the genre structure and design principles only: four-survivor team play, safe rooms, chapter-based campaigns, an AI Director, roaming hordes, special enemy pressure roles, crescendo events, holdout finales, rescue extraction, shared item economy, incapacitation/revive, and strong co-op pacing.

### Target Engine And Coding Standards

Build in Godot 4.x using GDScript, not C#.

Use typed GDScript throughout:

- `class_name` for reusable systems.
- Explicit variable and function return types.
- Signals for decoupled communication.
- Scene composition over giant monolith scripts.
- Resource files for data-driven tuning.
- Object pools for bullets/tracers/decals/particles/horde enemies where useful.
- `CharacterBody3D` for player, bots, civilians, and enemies.
- Godot `NavigationRegion3D`/`NavigationAgent3D` for enemy, bot, and civilian pathing.
- Avoid per-frame allocations in hot combat loops.

Recommended project structure:

```text
project.godot
scenes/
  main/
    Main.tscn
    Boot.tscn
  hub/
    Safehouse.tscn
    ShopTerminal.tscn
  player/
    Player.tscn
    SurvivorBot.tscn
    FirstPersonViewmodel.tscn
  enemies/
    CommonInvader.tscn
    Breacher.tscn
    Enforcer.tscn
    Gunner.tscn
    Caller.tscn
  civilians/
    Civilian.tscn
  weapons/
    WeaponViewmodel.tscn
    ProjectileFx.tscn
  levels/
    falls_road/
    shankill/
    markets/
    docks/
    ardoyne/
    short_strand/
    divis_tower/
  ui/
scripts/
  autoload/
    GameState.gd
    SaveService.gd
    EventBus.gd
    AudioBus.gd
    Director.gd
    AssetRegistry.gd
  player/
  enemies/
  weapons/
  levels/
  ui/
resources/
  data/
    levels/
    enemies/
    weapons/
    upgrades/
    boots/
    modifiers/
    achievements/
  materials/
assets/
```

### Core Game Identity To Preserve

The game is not a generic zombie shooter. It is a kick-heavy, grimy, low-fi Belfast FPS about an uneasy alliance defending the city from fictional invaders.

Preserve these pillars:

- The boot is a primary weapon. Kicking doors, enemies, crates, barrels, and special interactions must feel immediate and violent.
- Breaching interiors is a core rhythm: move through damp streets, kick in doors, rescue civilians, clear rooms, escape to extraction.
- The safehouse is a real 3D place, not just a menu. It contains the campaign board, landline level-code system, black-market shop terminal, allies, story logs, and loadout management.
- The tone is damp, nocturnal, PS1-horror, working-class Belfast: rain, fog, street lamps, murals, terraced houses, phone booths, bins, barricades, pubs, docks, markets, tower blocks.
- The story centers on fictional invaders and cross-community cooperation. Do not frame Catholics, Protestants, republicans, loyalists, or any real protected class as targets. Local factions may be tense allies, rivals, or civilians, but the enemies are fictional invaders.

### Recreate Current Mechanics First

Implement a playable vertical slice before expanding the campaign:

- First-person controller: look, move, sprint stamina, jump, slide/crouch, fall/step handling, mouse/gamepad/touch-ready abstractions.
- Health system: damage, death/down state, delayed regeneration or temp-health rules as appropriate.
- Kick system: cone/radius detection, cooldown, first-person boot animation, door breach, enemy knockback/damage, barrel/crate interaction, impact effects, camera shake/hitstop.
- Weapon system: pistol, boomstick, SMG; magazines, reloads, hitscan, spread, pellets, muzzle flash, tracer, surface decals, blood impacts, weapon switching, ownership gating.
- Door system: kickable doors with collision blocked until opened; door swing animation; door breach events.
- Enemy system: common melee invaders, gunner/rusher, enforcer, breacher. Preserve the current roles but improve pathing and readability.
- Civilian rescue: captors menace civilians, civilians can lose life, player rescues by interaction, rescued civilians flee, saved/dead state affects score and results.
- Explosive barrels and supply crates.
- Score/combo/results: kills, boot kills, barrel kills, civilian saves, time, flawless, style bonuses.
- Persistent progression: Resistance Points, upgrade levels, owned/equipped boots, owned weapons, level unlocks, achievements, settings, redeemed codes.
- Modifiers: Rainy Night, Curfew, Adrenaline or Godot equivalents.
- HUD: health, stamina, ammo, weapon, objective, operation code, combo, civilian wellbeing, crosshair, damage vignette, adrenaline distortion, interact prompt, title cards, results screen.

### Expand Into A Full Horde-Shooter Campaign

After the vertical slice works, expand the game into a full campaign using Left 4 Dead-like structure without copying Left 4 Dead content.

Minimum campaign target:

- Seven Belfast operations based on the existing sectors:
  - Falls Road: residential breach tutorial and first alliance operation.
  - Shankill: street gauntlet and cross-community trust beat.
  - The Markets: dense market maze with alarm/crescendo routes.
  - The Docks: industrial container yards, cranes, warehouses, chain explosions.
  - Ardoyne: tight residential maze with heavier ambushes and rescue pressure.
  - Short Strand: siege pocket, surrounded streets, civilian defense, high horde density.
  - Divis Tower: vertical finale, stairwell climb, rooftop command post, extraction.
- Each operation should contain 3-5 chapters with safe-room starts/ends, item restocks, chapter stats, and narrative beats.
- Each operation needs at least one crescendo event and one finale-style holdout or escape beat.
- Use authored layouts supported by procedural dressing, not one repeated arena. Maintain Belfast landmarks, terraced streets, interiors, pubs, markets, docks, tower blocks, courtyards, alleyways, rooftops, and service tunnels.

Core horde-shooter systems:

- Four-survivor structure. Minimum: one human player plus three competent AI companions. Optional: online co-op if project scope allows, but do not block the campaign on networking.
- Incapacitation and revive. A downed survivor can be revived by teammates; full death waits until a rescue closet/safe room or chapter transition.
- Shared survival item economy: medkits, temporary boost items, throwable noise-makers/explosives, ammo caches, and limited special ammo.
- AI Director:
  - Tracks team intensity, health, ammo, recent damage, progress, separation, civilian state, and downtime.
  - Spawns ambient threats, horde waves, special enemies, item drops, and quiet breaks.
  - Avoids unfair spawn positions in direct sight unless scripted.
  - Escalates if players camp too long.
  - Supports per-level profiles and event scripts.
- Horde waves:
  - Common invaders swarm, climb/vault simple obstacles where practical, break through doors/windows, and converge from believable entrances.
  - Crescendo events keep spawning until players complete an objective: shut off an alarm, open a barricade gate, restart a generator, hold a phone exchange, lower a dock bridge, clear a stairwell blockage, etc.
- Special enemies, original names and behavior:
  - Breacher: fast serpentine explosive rusher.
  - Enforcer: tank-like heavy; kick-resistant; creates space-control pressure.
  - Gunner: ranged suppressor or fast melee rusher, depending on final balance, with strong telegraphing.
  - Caller: alerts hordes unless interrupted.
  - Snatcher: drags isolated players into alleys or rooms.
  - Stalker: ambushes from interiors/rooftops.
  - Shieldbearer: front-resistant enemy that rewards flanking/kicking.
- Finales:
  - Docks: hold a warehouse/harbor crane area until extraction arrives.
  - Short Strand: defend civilians while opening a route through a siege pocket.
  - Divis Tower: climb under pressure, destroy/disable the invader command post, survive rooftop finale, extract by helicopter or improvised lift.

### Belfast Campaign Chapter Sketch

Use this as the authored direction. Modify as needed for fun and scope.

1. Falls Road
   - Chapter 1: Safehouse Pub to Terraced Row. Teach kick, breach, pistol, rescue.
   - Chapter 2: Back Lanes. Introduce horde alarm and first breacher.
   - Chapter 3: Community Hall Holdout. Rescue civilians and reach extraction.

2. Shankill
   - Chapter 1: Barricade Street. Long sightlines, gunners, roadblocks.
   - Chapter 2: Orange Hall Backrooms. Interior breach and ally dialogue.
   - Chapter 3: Peace Line Crossing. Crescendo gate opening with both factions helping.

3. The Markets
   - Chapter 1: Covered Stalls. Tight market lanes and item scarcity.
   - Chapter 2: Alarmed Arcade. Shut off multiple alarms while hordes flood in.
   - Chapter 3: Loading Yard. Finale around a market loading bay.

4. The Docks
   - Chapter 1: Warehouse Row. Crates, forklifts, explosive barrels.
   - Chapter 2: Container Maze. Vertical catwalks and ambush specials.
   - Chapter 3: Dry Dock Crane. Crescendo crane startup.
   - Chapter 4: Harbor Extraction. Holdout until boat/vehicle extraction.

5. Ardoyne
   - Chapter 1: Tight Maze. Dense residential interiors and reduced visibility.
   - Chapter 2: School/Church Route. Civilian rescue under captor pressure.
   - Chapter 3: Barricade Break. Multi-stage crescendo with limited ammo.

6. Short Strand
   - Chapter 1: Surrounded Pocket. Hordes from multiple approach lanes.
   - Chapter 2: Relief Run. Escort/rescue civilians between houses.
   - Chapter 3: Siege Finale. Defend a pocket until evacuation route opens.

7. Divis Tower
   - Chapter 1: Base Perimeter. Enforcers and barricades.
   - Chapter 2: Stairwell Climb. Vertical combat and claustrophobic waves.
   - Chapter 3: Rooftop Command Post. Disable invader equipment.
   - Chapter 4: Belfast Liberated. Final holdout and extraction.

### Data-Driven Resources

Create Godot `Resource` classes or JSON importers for:

- `LevelDef`: id, display name, operation index, chapter index, intro, outro, safe room positions, extraction/finale type, par time, director profile, weather, story beats.
- `EnemyDef`: health, speed, run speed, detection, attack type, damage, cooldown, stagger, kick response, spawn cost, director tags.
- `WeaponDef`: id, name, damage, rpm, spread, pellets, magazine size, reload time, recoil, audio, viewmodel, unlock cost.
- `UpgradeDef`: id, name, description, max level, cost array, effect type/value.
- `BootDef`: id, name, description, cost, ability.
- `ModifierDef`: id, name, description, effects, score/reward multiplier.
- `AchievementDef`: id, name, description, event trigger, optional platform id.

### Safehouse And Meta Progression

Implement the safehouse as the campaign hub:

- 3D pub/basement staging scene with allies, campaign board, laptop shop, landline, exit door/start operation fixture.
- Menu overlays should feel like in-world screens or panels, not generic UI.
- Shop categories: weapons, upgrades, boots.
- Story logs unlock by campaign progress.
- Landline codes can unlock or jump to operations and grant one-time RP, matching the original spirit.
- Campaign completion should show `BELFAST LIBERATED` and persist completion state.

Progression must never make the campaign impossible for new players. Upgrades should add build identity and replay value, not mandatory stat checks.

### Visual And Audio Direction

Use existing assets where possible:

- Models: weapons, kick boot, enemies, victims, barrels, crates, doors, Belfast props, buildings, furniture, CRT/ThinkPad, phone booth, car, barricades.
- Textures: brick, tarmac, concrete, roof, pavement, urban signs, graffiti, doors, windows, grass, murals, hub textures.
- VFX sprites: muzzle flash, kick impact, blood, bullet hole.
- Audio: gunshots, reload, explosion, door kick, rescue jingle, screams, ambient music/loops.

Godot import requirements:

- Import GLB assets under `res://assets/models/`.
- Create `.import` settings appropriate for Godot 4.
- Use simple collision primitives for buildings and props; do not rely on detailed mesh collision for large city models.
- Use Navigation meshes for walkable spaces and enemy routes.
- Use lower-fidelity stylization intentionally: pixelated/nearest textures where useful, heavy fog, rain particles, low light, limited far view, subtle camera shake, screen-space damage/adrenaline effects, and chunky decals.

### Controls

Desktop:

- WASD move.
- Mouse look.
- Shift sprint.
- Space jump.
- Ctrl/C slide.
- F kick.
- Left mouse fire.
- R reload.
- 1/2/3 and mouse wheel switch weapons.
- E interact/rescue.
- Esc pause.
- M mute.

Gamepad:

- Left stick move.
- Right stick look.
- Right trigger fire.
- Face buttons for jump/kick/reload/interact.
- Shoulder buttons for weapon cycling.
- Start pause.

Touch:

- Virtual move stick.
- Look pad.
- Fire, kick, jump, sprint, reload, weapon switch, pause.
- Tappable interact prompt.

### Implementation Milestones

1. Project bootstrap
   - Create Godot 4.x project, autoloads, input map, main scene, save service, event bus, and asset registry.

2. Player and weapon vertical slice
   - FPS controller, kick, pistol, dummy enemies, HUD, damage, death/down state.

3. Belfast test sector
   - One playable Falls Road-style map with streets, interiors, kickable doors, crates, barrels, civilians, extraction.

4. Enemy and Director foundation
   - Common invaders, breacher, enforcer, gunner, director spawn budgets, horde waves, alarm escalation.

5. Safehouse and progression
   - Hub scene, shop, upgrades, boots, weapon unlocks, save/load, story logs, level select/codes.

6. L4D-like team systems
   - Three AI companions, revive/incap, shared items, companion combat/rescue behavior, safe rooms.

7. Campaign chapters
   - Build all operations and chapters with safe rooms, crescendos, finales, and story beats.

8. Polish and completion
   - Full UI, audio, settings, accessibility toggles, achievements, balancing, campaign-complete flow, packaging.

### Acceptance Criteria

The final Godot game is complete when:

- A new player can start in the safehouse, deploy into Falls Road, complete all operations through Divis Tower, and see a campaign-complete ending.
- Every operation has distinct layout, pacing, mood, and at least one major scripted event.
- The AI Director produces quiet periods, pressure spikes, fair special spawns, and anti-camping behavior.
- The player can complete the game solo with AI companions.
- Civilians matter mechanically and narratively.
- Kicking, breaching, and close-quarters speed remain the game's unique identity.
- Progression, upgrades, boots, weapons, achievements, settings, and story logs persist.
- No real-world Belfast faction or protected group is used as the enemy.
- No Left 4 Dead copyrighted content is copied.
- The project runs at a stable framerate on target hardware with reasonable enemy counts.
- The codebase is clean, typed, signal-driven, and organized for future content.

### Verification

Before declaring completion:

- Run the Godot project and play through at least one full operation end to end.
- Smoke-test all weapons, kick interactions, revives, item pickups, civilian rescue, safe rooms, director horde waves, crescendos, finales, progression saves, and campaign completion.
- Test keyboard/mouse and gamepad controls.
- Verify no navigation deadlocks: enemies, bots, and civilians must not block campaign progress.
- Confirm every chapter has reachable extraction/safe-room flow.
- Confirm settings persist after restart.
- Review all story/dialogue for the IP and real-world faction safety boundaries above.

# Asset research (PLAN §4.1)

All licence statements were checked on **2026-11-08**, on the official page linked in each row, and
again inside the downloaded archive (the `License*.txt` shipped with the files) where there is one.
Gate: commercial use **and** redistribution inside a shipped game must be allowed. CC0 preferred,
CC-BY acceptable (with credit), reject NC / ND / unclear / login-gated-with-no-redistribution.
`?` = not stated by the source and not measured by us. Numbers marked (m) were measured on the
downloaded files with gltf-transform.

## Decision summary

| Need | Pick | Why |
|---|---|---|
| Hero wizard | **POC "Wizard"** (Quaternius RPG Character Pack, CC0), own 32-bone rig | It *is* the visual source of truth (reference/poc). 5,376 tris. Native idle/walk/run/spell/hit/death clips; missing clips come from UAL **retargeted in Node** onto the same skeleton, so the final GLB has one skeleton. |
| Extra hero clips | **Quaternius UAL1 + UAL2 (Standard, CC0)** | 85 free clips on a UE-mannequin rig; Roll, Sword_Dash, Fixing_Kneeling retargeted. |
| THE EDITOR | **Quaternius Universal Base Character (male, CC0)** + UAL clips natively + procedural visor/pencil (original) | Same rig as UAL ⇒ 13 boss clips with zero retarget error; 14.5k tris. No free giant/golem exists on any rig (see rejections). |
| Eraser, stumps, visor, pencil | **Original** (scripts/build/originals.ts) | Nothing suitable under CC0; procedural low-poly matches the style and is ours. |
| Forest props | **Quaternius Stylized Nature MegaKit** (rocks, mushrooms, fern), **KayKit Forest** (bush), **KayKit Halloween Bits** (dead trees) | CC0, fetchable without login. |
| Graveyard / ruins | **KayKit Halloween Bits 1.0** (GitHub, pinned commit) | CC0; graves, lanterns, crypt, arches, fences, shrine, skull, candles in one 128 px atlas. |
| Paper grain | **ambientCG Paper003** (CC0) | Poly Haven has no paper/cardboard textures. |
| Fonts | **Bangers** + **Comic Neue Bold** (OFL 1.1) | Comic display + readable body; OFL text shipped next to the files. |

Mixamo stays out (DECISIONS 2026-11-08). KayKit **Mage** (CC0, 5.7k tris, 76 native clips incl.
spellcasts, hat/cape/staff parts, direct GitHub GLB) is the documented fallback hero if the POC look is
ever dropped.

## Important findings

1. **Quaternius licence change.** quaternius.com/license.html now shows the *Quaternius Asset License
   (QAL) v1.0, last updated 8/28/2026*: commercial use, no credit, but no redistribution of the assets
   *as assets*. The itch pages we use still say "Asset license: Creative Commons Zero v1.0 Universal"
   (UAL2: CC0 only in the description text), and **every zip we downloaded contains a License.txt
   stating CC0 1.0**. CC0 is irrevocable for the copies obtained under it; QAL would also permit our
   use (a game that incorporates them). Consequences: (a) we record CC0 with the shipped licence file
   as evidence and pin checksums in `assets/sources.lock.json`; (b) raw packs are never committed
   (`assets/source/.gitignore`), only game-ready derived files ship.
2. **Quaternius free tiers are thin**: UAL2 Standard 42/130+ clips, UBC 2 bodies, Outfits-Fantasy
   only Ranger+Peasant (the wizard outfit is in the paid Source tier), Bestiary (QAL) free tier only
   Imp/Puglin — the brute/ogre is paid.
3. **Google Drive hosting is unreliable** (RPG Character Pack, Ultimate Monsters, Ultimate Ruins):
   anonymous downloads returned "Quota exceeded". The POC wizard is therefore taken from the repo copy
   (`reference/poc/wizard-model.js`, checksum-pinned) with the Drive folder as documented upstream.
4. **Kenney** removed static zip URLs (cookie + signed expiring link). Not needed for M1; manual
   download documented if audio packs are wanted later.
5. **Poly Pizza** API needs an account key and its ToS forbids automated download; per-model licences
   (CC0 or CC-BY 3.0, e.g. "Animated Wizard" by Quaternius is listed CC-BY 3.0 there). Manual only.
6. **Sketchfab** requires login; API must be authenticated; operator now KitBash SF Operations LLC.
   Manual only, not for a reproducible pipeline.
7. three.js example models: only RobotExpressive is clearly CC0; Xbot/Soldier/Michelle are
   Mixamo-derived without licence file → rejected.
8. Sonniss / Pixabay licence pages sit behind bot checks; their terms (no-AI clause, "standalone"
   redistribution limits) need a human read before any audio is taken from them (audio workstream).

## Candidate table (models, animation, textures, fonts)

| Source | Licence (+URL) | Attribution | Format | Rig | Skeleton / bone names | Bones | Animations | Tris | Textures | Download | Use in INKWAKE |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Quaternius RPG Character Pack — Wizard (POC) <https://quaternius.com/packs/rpgcharacters.html> | CC0 1.0 — creativecommons.org/publicdomain/zero/1.0 | No | glTF/GLB, FBX, OBJ, blend | Yes | Quaternius 2019 rig: Root, Body, Hips, Abdomen, Torso, Neck, Head, Shoulder/UpperArm/LowerArm/Fist(.L/.R), Fist1/2, Thumb1/2, UpperLeg/LowerLeg, IK feet under Root (m) | 32 (m) | 11 (m): Death, Idle, Idle_Weapon, PickUp, Punch, RecieveHit, RecieveHit_Attacking, Run, Spell1, Staff_Attack, Walk | 5,376 (m) | 1024² + 512² PNG (m) | Google Drive (quota-limited) → repo copy | **Hero** |
| Quaternius Universal Animation Library <https://quaternius.itch.io/universal-animation-library> | CC0 1.0 (itch sidebar + License.txt in zip) | No | GLB/FBX (+RM variants) | mannequin | UE5-mannequin names: root, pelvis, spine_01–03, neck_01, Head, clavicle/upperarm/lowerarm/hand_l/r, fingers, thigh/calf/foot/ball (m) | 65 (m) | 43 free (m) incl. Idle_Loop, Walk_Loop, Jog/Sprint, Roll, Spell_Simple_*, Hit_Chest/Head, Death01, Fixing_Kneeling, Dance_Loop, Pistol_*, Sword_*, Sitting_* | 13,744 mannequin (m) | none | itch name-your-price ($0) — scripted | Hero roll/kneel source; boss clips |
| Quaternius Universal Animation Library 2 <https://quaternius.itch.io/universal-animation-library-2> | CC0 1.0 (description text + License.txt) | No | GLB/FBX | mannequin | same as UAL1 (m) | 65 | 43 free (m) incl. Sword_Dash, Sword_Heavy_Combo, Sword_Regular_A/B/C, TreeChopping_Loop, OverhandThrow, Hit_Knockback, Idle_No_Loop, Idle_FoldArms_Loop, Idle_Lantern_Loop, Zombie_* | 13,744 | none | itch ($0) | Hero dash; boss attacks |
| Quaternius Universal Base Characters <https://quaternius.itch.io/universal-base-characters> | CC0 1.0 | No | glTF+bin, FBX | Yes | UAL rig (m) | 65 | none | 12,566 body + 984 brows + 768 eyes (m) | 2048² PNG (base/normal/rough) | itch ($0, 122 MB) | **THE EDITOR** body |
| Quaternius Modular Character Outfits – Fantasy <https://quaternius.itch.io/modular-character-outfits-fantasy> | CC0 1.0 | No | glTF, FBX | Yes | UAL rig (m) | 65 | none | Ranger 26,982 / Peasant 12,894 (m) | 4096² PBR | itch ($0, 280 MB) | Rejected: no wizard in free tier, realistic proportions clash with POC, 4K textures |
| Quaternius Stylized Nature MegaKit <https://quaternius.itch.io/stylized-nature-megakit> | CC0 1.0 | No | glTF, FBX, OBJ | No | – | – | – | rocks 244–522, mushroom 880, shelf fungus 3,216→2,528 after simplify, trees 6–10k (m) | PNG atlases (m) | itch ($0, 99 MB) | Rocks, pebble, mushrooms, fern |
| Quaternius Ultimate Monsters <https://quaternius.com/packs/ultimatemonsters.html> | CC0 (site) | No | FBX/OBJ/glTF/blend | per-monster | ? | ? | ? | ? | ? | Google Drive (quota) | Not used (unreliable download, no giant humanoid confirmed) |
| Quaternius Bestiary – Dungeon Monsters <https://quaternius.itch.io/bestiary-dungeon-monsters-kit> | **QAL** v1.0 | No | GLB/FBX | Yes | UAL rig | ? | none | ? | ? | itch; brute is paid | Rejected for M1 (QAL + paid tier) — optional boss upgrade |
| KayKit Adventurers (Mage) <https://kaylousberg.itch.io/kaykit-adventurers> | CC0 (itch + LICENSE.txt) | No | GLB/FBX | Yes | KayKit Rig_Medium (hips, spine, chest, upperarm.l …) | 41 | 76 incl. Spellcast_*, Hit, Death, Dodge, Cheer | 5,683 | 1024² gradient atlas | GitHub raw GLB (v1.0) / itch (v2.0) | Fallback hero |
| KayKit Halloween Bits 1.0 <https://kaylousberg.itch.io/halloween-bits> | CC0 (LICENSE in repo) | No | glTF/FBX/OBJ | No | – | – | – | 56–952 per prop (m) | one 1024² atlas → 128² (m) | GitHub codeload, pinned commit 6dc69bf | Graves, lanterns, crypt, arches, fences, shrine, skull, candles, dead trees |
| KayKit Forest Nature Pack (Free) <https://kaylousberg.itch.io/kaykit-forest> | CC0 (License.txt) | No | glTF/FBX/OBJ | No | – | – | – | bush 72 (m) | 1024² atlas | itch ($0, 6 MB) | Bush |
| KayKit Skeletons / Dungeon Pack | CC0 | No | GLB/FBX | Skeletons yes | Rig_Medium | 41 | 95 | ~5.3k | atlas | GitHub / itch | Not needed in M1 (Skeleton Golem boss is paid Extra) |
| Kenney Graveyard Kit 5.0 <https://kenney.nl/assets/graveyard-kit> | CC0 (kenney.nl/support + License.txt) | No | GLB/FBX/OBJ | node-animated, no skin | – | 0 | 32 per character | gravestone 178, ghost 413 | 512² colormap | cookie-gated signed link (manual) | Alternative graveyard set |
| Kenney audio (RPG, Impact, Interface) | CC0 | No | OGG | – | – | – | – | – | – | manual | Audio workstream |
| Poly Pizza <https://poly.pizza> | per model (CC0 / CC-BY 3.0) | per model | GLB | some | varies | – | – | – | – | API key; ToS bans scraping | Manual one-offs only |
| Poly Haven <https://polyhaven.com/license> | CC0 | No | – | – | – | – | – | – | no paper textures exist | API | Not used |
| ambientCG Paper003 <https://ambientcg.com/view?id=Paper003> | CC0 (ambientcg.com/license) | No | JPG/PNG maps | – | – | – | – | – | 1024² colour (σ≈3 grey) | direct `get?file=Paper003_1K-JPG.zip` | **Paper grain** (normalised, 1024² + 512² WebP) |
| OpenGameArt | per asset | per asset | – | – | – | – | – | – | – | direct | Manual, CC0/CC-BY only, avoid GPL/SA |
| Mesh2Motion <https://mesh2motion.org> | tool MIT, assets CC0 | No | GLB | auto-rig | its own rigs | – | 170+ | – | – | web app | Future: rig a custom boss mesh |
| Sketchfab | per model | per model | – | – | – | – | – | – | – | login | Rejected as pipeline source |
| three.js RobotExpressive | CC0 (README) | No | GLB | Yes | Hips/Abdomen/Torso… | 43 | 14 | 3,237 | – | GitHub | Dev placeholder only |
| three.js Xbot / Soldier / Michelle | none (Mixamo-derived) | – | – | – | – | – | – | – | – | – | **Rejected** |
| Mixamo | Adobe ToS | – | – | – | – | – | – | – | – | login | **Rejected** (DECISIONS) |
| Google Fonts Bangers <https://fonts.google.com/specimen/Bangers> | OFL 1.1 (ofl/bangers/OFL.txt) | licence text shipped | TTF | – | – | – | – | – | – | GitHub raw, pinned commit | Display font |
| Google Fonts Comic Neue | OFL 1.1 | licence text shipped | TTF | – | – | – | – | – | – | GitHub raw, pinned commit | Body font |
| Luckiest Guy / Permanent Marker | Apache 2.0 | NOTICE | TTF | – | – | – | – | – | – | GitHub | Alternatives |
| Bowlby One SC | OFL 1.1 with Reserved Font Names | – | TTF | – | – | – | – | – | – | GitHub | Avoid (RFN complicates subsetting) |

## Wizard clip map (`wizard@<clip>`, one 32-bone skeleton, all in place)

| Clip | Origin |
|---|---|
| idle, walk, run, hit_react, death, pickup, staff_attack | native POC clips |
| cast_tap | native Spell1, from end of wind-up (32 %) to recovery |
| cast_hold_loop | authored: idle body + right arm frozen at Spell1 apex, staff solved upright, forearm sway |
| dash | UAL2 Sword_Dash → retargeted |
| roll | UAL1 Roll → retargeted |
| kneel | authored: UAL1 Fixing_Kneeling legs (retargeted) + bowed idle torso, breathing |
| victory | authored: staff thrust up, beat bounce, head tilt |
| look_around | authored: neck/head sweep over two idle cycles (seamless) |

Sockets: `socket_crystal` (staff tip, +Y along the staff), `socket_staff_foot`, `socket_head`,
`socket_hand_l`. Boss: `socket_eraser` (right palm), `socket_head`. Eraser: `socket_erase_edge`.

# INKWAKE — Claude Code Handover Planı

> Bu doküman Claude Code'un baştan sona tek başına yürütmesi için yazıldı. Repo kökünde `PLAN.md` olarak dursun. Ayrıca kısaltılmış hali `CLAUDE.md` içine kopyalansın (bkz. §17).
> Hedef: **production kalitesinde, oynanabilir bir mobil web (PWA) demo.** Tam oyundan tek farkı **oynanış süresi** olacak (5–8 dk). Kalite, cila, performans, UX, ses ve kararlılık açısından mağazaya çıkacak bir ürün gibi davranılacak.

---

## 0. Özet (TL;DR)

| Konu | Karar |
|---|---|
| Oyun | **INKWAKE**: Dünya henüz basılmamış bir pulp çizgi roman sayfası. Büyücünün kristali **ışık değil mürekkep** saçıyor ve ışığın değdiği yer çiziliyor. |
| Demo kapsamı | "Issue #1: The Unprinted Wood". 3 sayfa ve 1 boss, toplam 5–8 dk. |
| Platform | Mobil öncelikli web, **PWA** (offline, kurulabilir). Masaüstünde de oynanabilir. |
| Stack | TypeScript, **Bun** (paket yöneticisi ve script'ler), **Vite**, **three.js r170+**, gltf-transform, vite-plugin-pwa |
| Asset lisansı | Ticari kullanıma izin veren her lisans kabul (CC0 tercih, CC-BY ve benzerleri OK). **Her asset `licenses.json`'a kaydedilir**, oyunda Credits ekranı olur. |
| Ses | Dahil: SFX, ambient ve müzik (ticari lisanslı kaynaklardan) |
| Görsel referans | Mevcut POC "Pulp Ink Shader — three.js POC" (Quaternius Wizard, posterize toon, line-screen, paper grain, line boil). Kaynak dosyalar `reference/poc/` altına konacak. |

---

## 1. Ürün tanımı

### 1.1 Fantezi (player fantasy)
"Kendi çizgi romanımı ışığımla basıyorum." Oyuncu karanlık ve boş bir kâğıt dünyada ilerliyor. Her adımda etrafını mürekkeple yaratıyor, kâğıttan hayaletleri görünür kılıp yok ediyor.

### 1.2 "Wow" sütunları (pazarlıksız)
1. **Mürekkep sızması (ink reveal):** Kristal alanı açıldığında dünya bir anda belirmiyor, fbm maskesiyle **sızarak** yayılıyor. Kenarda ıslak mürekkep parlıyor ve kalem eskizi görünüyor.
2. **Panel kesmeleri:** Kritik vuruş, boss faz geçişi ya da ilk düşman karşılaşmasında zaman 0.6 sn donuyor. Ekran 2–3 çizgi roman paneline bölünüyor (her panel ayrı kamera açısı) ve onomatope ("KRAK!", "FWOOSH") basılıyor.
3. **Sayfa çevirme:** Bölüm geçişleri gerçek kâğıt kıvrılma shader'ıyla yapılıyor. Arka yüzde bir sonraki sahne zaten render edilmiş oluyor.
4. **Line boil:** Karakter animasyonları 12 fps'e "step"lenip çizgiler kaynıyor. Kamera ve VFX 60 fps akıyor.
5. **Sınırlı palet:** Teal orman, kırmızı-somon karakterler, altın kristal ve krem kâğıt. Palette olmayan renk ekrana çıkamaz.

### 1.3 Demo sınırı
Tam oyun "Issue"lardan oluşuyor. Demo = Issue #1. Kod, içerik pipeline'ı ve sistemler tam oyuna ölçeklenecek şekilde yazılır. **Kısaltılan tek şey içerik miktarı.**

---

## 2. Görsel yön ve render pipeline

### 2.1 Palet (POC'den, birebir kullan; `ColorManagement.enabled = false`)
```ts
export const PAL = {
  ink:   '#16100e',
  red:   ['#16100e', '#6e2f2c', '#b8655c', '#d99682'],   // karakter (robe/skin)
  teal:  ['#111816', '#1d3a38', '#3c6f6a', '#69a197'],   // orman/zemin
  staff: ['#16100e', '#2a2224', '#4b3f44', '#6c5d63'],   // asa/metal/taş
  glowCore: '#f6c35a', glowEdge: '#e2794e', smoke: '#d27b6c',
  paper: '#efe1c9',
  // EKLENECEK: düşman (kâğıt hayalet) rampası — paper tonlarından türetilmiş
  ghost: ['#16100e', '#bfae93', '#e3d3b8', '#f7eedd'],
};
```

### 2.2 Shader katmanları (sırasıyla)
1. **Toon/posterize material** (`InkMaterial`): POC'deki `toonVert/toonFrag` temel alınır. Desteklemesi gerekenler:
   - skinning, instancing, morph (opsiyonel)
   - 4 kademe ramp, wrapped-lambert key light, kristal point light (`uCrystalPos`), fog → ink
   - band kenarlarında fbm wobble (elle mürekkeplenmiş his)
   - `onBeforeCompile` yerine kendi `ShaderMaterial` + three chunk include'ları (POC'deki gibi)
2. **Reveal mask (çekirdek mekanik):**
   - `uRevealCenter` (kristal world pos), `uRevealRadius` (animasyonlu), `uRevealHistory` (opsiyonel kalıcı iz: düşük çözünürlüklü top-down **reveal render target**, 256², dünya XZ'ye map'li, her frame fade ile güncellenir).
   - Fragment: `m = smoothstep(r, r - edge, dist + fbm(wpos.xz*3)*0.6)`; `col = mix(paperSketch, inked, m)`.
   - `paperSketch`: kâğıt rengi + kurşun kalem hatch (ekran uzayında açılı çizgiler, sadece silüet/ön kenarlarda).
   - Maske kenarında 1–2 px **ıslak mürekkep** parlaması (`glowEdge`).
3. **Outline:** İki yöntem uygulanıp A/B yapılır, kalite/perf'e göre seçilir:
   - (A) Inverted hull (karakterler ve hayaletler için, skinning uyumlu, normal boyunca extrude). Kalınlık ekran-uzayı sabit, boil noise ile titreşim.
   - (B) Post-process depth+normal Sobel edge (çevre için). Mobilde yarım çözünürlükte.
4. **Post-process (tek fullscreen pass, birleşik):**
   - line-screen / halftone (açı 62°, periyot 3.4 px@1x, gölge tonlarında aktif)
   - paper grain + lif dokusu (CC0 kâğıt texture'ı + procedural noise)
   - hafif **misregistration** (kanal kayması, 0.5 px; ayarla kapatılabilir)
   - vinyet: ink
   - Tümü `EffectComposer` yerine **elle yazılmış minimal post pipeline** (1 RT + 1 fullscreen triangle). Overhead düşük kalır.
5. **Line boil:** `uBoilSeed` 12 Hz'de step'lenir. Outline ve band wobble noise'u bu seed ile offsetlenir. Karakter `AnimationMixer.update` çağrıları 1/12 sn biriktirilerek uygulanır (kamera ve VFX etkilenmez). "Reduce motion" ayarında boil kapanır.
6. **VFX:** Mürekkep sıçraması (instanced quad, flipbook SDF blob), kâğıt yırtılma parçacıkları, kristal halo (additive, palette'den), onomatope sprite'ları (vektör, SVG'den bake edilmiş MSDF ya da canvas texture).

### 2.3 Kamera
- 3/4 üstten takip kamerası, hafif gecikmeli spring. Sinematik anlarda kamera ray'leri (CatmullRom).
- Dikey (9:16) **birincil** framing; yatayda FOV ve offset otomatik uyarlanır.
- Panel kesmeleri: aynı sahne 2–3 kamera ile **scissor/viewport** üzerinden tek frame'de render edilir. Panel çerçevesi ink, aralar paper.

### 2.4 Sayfa çevirme
- Önce mevcut frame ve yeni sahnenin ilk frame'i RT'ye alınır. Fullscreen'de bükülen kâğıt mesh'i (grid, vertex shader'da silindirik curl), ön yüz = eski RT, arka yüz = kâğıt dokusu, altında yeni RT.
- Süre 0.9 sn, ses ile senkron.

---

## 3. Oyun tasarımı (Issue #1: "The Unprinted Wood")

### 3.1 Çekirdek döngü
Keşfet (mürekkeple) → Hayaletleri göster ve yok et → Mürekkep topla → Engeli "çizdir" → İlerle

### 3.2 Mekanikler
| Mekanik | Detay |
|---|---|
| Hareket | Sol başparmak: dinamik sanal joystick (dokunduğun yerde açılır). Koşma/yürüme analog. |
| Kristal (ink light) | Sağ alanda **basılı tut** → yarıçap 3 m'den 7 m'ye büyür (0.6 sn ease) ve **Mürekkep** enerjisi harcar (saniyede ~12/100). Bırakınca yavaşça 3 m'ye döner. Enerji 0 → 1.5 m "kısık" mod. |
| Ink bolt | Sağ alanda **tap** → en yakın *görünür* hayalete otomatik hedefli mermi (5 enerji). Görünmeyen (maske dışı) hayalet hedeflenemez ve hasar almaz. |
| Ink dash | Sağ alanda **swipe** → 4 m atılma, 0.25 sn i-frame, 2 sn cooldown, arkada mürekkep izi bırakır (iz geçici olarak reveal eder). |
| Mürekkep toplama | Ölen hayaletler ve "ink well"ler (mürekkep hokkası) enerji bırakır. Mıknatısla çekilir. |
| "Çizdirme" bulmacaları | Kesik çizgili eskiz objeleri (köprü, merdiven, kapı): kristali 7 m'de **2 sn** tutunca obje "basılır" ve kalıcı olur. Çizim sırasında hayaletler saldırır (gerilim). |
| Can | 5 "sayfa" (kalp yerine yırtık sayfa ikonu). Hasar = sayfa yırtılır. Checkpoint'te tazelenir. |
| Checkpoint | Her sayfa başı ve boss öncesi. Ölünce **sayfa yeniden basılır** animasyonu (mini sayfa çevirme). |

### 3.3 Düşmanlar
| Ad | Davranış | Görsel |
|---|---|---|
| **Smudge** (temel) | Maskenin dışında bekler, kenarından içeri dalar, temas hasarı. 2 vuruş. | Buruşuk kâğıt hayalet, ghost rampası, outline yok (maske içinde outline belirir) |
| **Scribbler** | Uzaktan kalem çizgisi fırlatır (telegraph: 0.8 sn önce kesik çizgi). 3 vuruş. | Uzun kâğıt figür |
| **Blot** (sadece sayfa 3) | Kristale doğru gelir, yakınında maske yarıçapını küçültür (enerji emer). Önce o öldürülmeli. | Mürekkep lekesi, ters palet |

AI: basit durum makinesi (Idle → Stalk (maske kenarı) → Attack → Recoil → Die), steering ile ayrışma. Aynı anda en fazla 8 aktif düşman.

### 3.4 Boss: **THE EDITOR**
Devasa yarı-basılı figür: üst gövdesi bitmiş mürekkep, alt yarısı kurşun kalem eskiz. Elinde dev bir silgi var.

| Faz | Süre | Davranış | Oyuncunun cevabı |
|---|---|---|---|
| 1 "Erase" | ~45 sn | Silgiyle zemini süpürür: arena şeritleri **silinir** (maske kalıcı olarak kapanır, hayaletler çıkar). | Şeritten kaç. Kollardaki 3 mürekkep noktasını ink bolt ile vur. |
| 2 "Redraw" | ~45 sn | Kendi silinmiş vücudunu yeniden çizer. Ekranda kesik çizgili zayıf noktalar belirir. | Zayıf noktaları kristali 7 m tutarak **basarak** sabitle ve vur. |
| 3 "Blank Page" | ~40 sn | Tüm arenayı kâğıda çevirir, sadece kristal ışığı var. Silgi hamleleri hızlanır. | Dash ile kaç, son 3 vuruşla bitir. Final panel kesmesi gelir, ardından kapak (cover) ekranı. |

Faz geçişleri = panel kesmesi ve onomatope. Toplam boss süresi 2–2.5 dk.

### 3.5 Akış ve süre bütçesi (hedef toplam 6–7 dk, ilk oyuncu)
| Beat | Süre | İçerik |
|---|---|---|
| Soğuk açılış | 0:20 | Boş kâğıt, kalem eskizi büyücü. İlk dokunuşta kristal yanar ve dünya sızar (WOW #1). Logo "INKWAKE" mürekkeple basılır. |
| Sayfa 1 "Ink" | 1:30 | Hareket ve kristal öğretimi (yazısız, görsel ipuçları). 3 Smudge. İlk panel kesmesi. İlk çizdirme: köprü. |
| Sayfa çevirme | 0:03 | WOW #3 |
| Sayfa 2 "Hollow" | 1:45 | Scribbler'lar, dash öğretimi, ink well'ler, 2 çizdirme bulmacası (merdiven ve dönen kapı), dar orman koridoru, sisli açıklık. |
| Sayfa çevirme | 0:03 | |
| Sayfa 3 "Blot" | 1:15 | Blot'lar, enerji yönetimi baskısı, kısa arena savaşı (dalga ×2). Boss kapısını çizdir. |
| Boss | 2:15 | THE EDITOR (3 faz) |
| Final | 0:30 | Kapak ekranı: oyuncunun en iyi panel anı kapak olarak basılır ("ISSUE #1 — COMPLETE"), istatistikler, **Paylaş** (Web Share API ve PNG indir), "Issue #2 coming soon", Credits. |

### 3.6 Zorluk ve erişilebilirlik
- "Story" ve "Normal" zorluk (hasar ve enerji çarpanları).
- Ayarlar: ses (master/music/sfx), titreşim, solak modu (kontrolleri ters çevir), reduce motion (boil/shake/flash kapalı), misregistration aç/kapat, kalite (Auto/Low/High), dil (TR/EN).
- Kritik bilgi sadece renkle verilmez (şekil ve ses ipucu da olur). Flash efektleri 3 Hz altında.

---

## 4. Asset stratejisi

### 4.1 Faz 0: Derin asset araştırması (Claude Code yapacak, kodlamadan ÖNCE)
Çıktılar: `docs/ASSET_RESEARCH.md` + `assets/licenses.json` + `assets/source/` (ham indirilenler, git LFS'siz, `.gitignore`'da değil; boyut büyükse `scripts/fetch-assets.ts` ile indirilebilir yap).

Her aday için tablo sütunları: **kaynak URL, lisans adı + lisans URL'si, atıf gerekli mi, format, rig var mı, iskelet standardı/kemik isimleri, kemik sayısı, animasyon listesi, tri sayısı, doku boyutu, indirme yöntemi (direkt URL / GitHub / login gerekli), INKWAKE'te kullanım yeri.**

Araştırılacak kaynaklar (lisans bilgileri **mutlaka resmi sayfadan doğrulanacak**, aşağıdakiler başlangıç hipotezi):

| Kaynak | Beklenen lisans | Neden ilgili |
|---|---|---|
| **Quaternius**: Universal Animation Library (UAL1/UAL2), Universal Base Characters, Ultimate Fantasy/RPG characters (Wizard dahil), Ultimate Monsters, Stylized Nature MegaKit | CC0 | Ortak humanoid rig ve 100+ retarget edilebilir animasyon. POC'deki Wizard buradan. |
| **KayKit** (Kay Lousberg): Adventurers, Skeletons, Forest/Nature, Dungeon, Halloween | CC0 (doğrula) | Tutarlı rig ve animasyon seti, GitHub'da olabilir |
| **Kenney**: Nature Kit, Graveyard Kit, Animated Characters, ses paketleri (RPG Audio, Impact, Interface) | CC0 | Prop'lar ve SFX |
| **Poly Pizza** | Model başına (CC0 / CC-BY) | Hızlı prop arama, API |
| **Poly Haven** / **ambientCG** | CC0 | Kâğıt/zemin dokuları, HDRI gerekmez ama referans |
| **Mesh2Motion** | Araç ve animasyon lisansını doğrula | Otomatik rig ve animasyon, custom boss/hayalet rig'i için |
| **Mixamo** | Adobe ToS: oyunda ticari kullanım serbest, ham dosyaların tek başına dağıtımı yasak (doğrula) | Ek animasyon gerekirse. Web build'de GLB içinde gömülü olması kabul edilebilir mi, ToS'tan teyit et. |
| **Sketchfab** (CC-BY / CC0 filtreli, "Downloadable") | Model başına | Boss ya da özel creature adayı |
| **OpenGameArt** (CC0 / CC-BY filtre) | Model başına | Ek model ve müzik |
| three.js `examples/models` (Xbot, Soldier, RobotExpressive vb.) | Dosya başına farklı (doğrula) | Sadece test ve dev placeholder |
| **Ses**: Kenney audio, Sonniss GDC Game Audio Bundle, freesound (CC0 filtre), OpenGameArt CC0 müzik, Pixabay (lisansı doğrula), Kevin MacLeod / incompetech (CC-BY) | Kaynak başına | SFX, ambient, müzik |

**Ret kriterleri:** Ticari kullanım yasak (NC), türev yasak (ND), lisansı belirsiz, login arkasında ve ToS'u redistribution'ı yasaklayan, tri sayısı karakter başına 15k üstü (gerekirse decimate edilir).

**Karakter eşlemesi (hedef):**
- Büyücü: Quaternius Wizard (POC ile aynı) ya da UAL uyumlu bir fantasy character. **Tercih: UAL iskeleti** (tüm animasyonlar tek kütüphaneden gelsin).
- Smudge/Scribbler: low-poly ghost/hayalet modeli + kâğıt deformasyonu (vertex shader'da buruşma noise'u). Uygun model yoksa procedural (lathe + noise) üret ve kemiksiz vertex animasyonu kullan.
- Blot: procedural metaball/SDF benzeri mesh + vertex animasyon.
- THE EDITOR: büyük humanoid ya da golem/giant (Quaternius Ultimate Monsters / Sketchfab CC-BY). UAL'a retarget edilebilir olmalı, boyut ×4. Silgi = ayrı prop, el kemiğine attach.
- Çevre: bükük ağaçlar POC'deki procedural trunk generator ile üretilsin (stil tutarlılığı için) + kaya, mantar, mezar taşı, fener, harabe prop'ları paketlerden.

### 4.2 Gerekli animasyonlar (büyücü)
idle, walk, run, dash (ya da roll), cast_tap (tek el), cast_hold_loop (asa yukarı), hit_react, death, victory, + sinematik için 2–3 ekstra (look_around, kneel). Hepsi tek GLB'de, isimlendirme `wizard@<clip>`.

### 4.3 Asset pipeline (`scripts/`)
1. `fetch-assets.ts`: kaynaklardan indir, checksum doğrula, `assets/source/`a koy (indirilemeyen login'li kaynaklar için README'ye manuel adım yaz).
2. `retarget.ts` (Node, three ile headless) ya da Blender headless script (`scripts/blender/retarget.py`): UAL animasyonlarını hedef karaktere retarget et, root motion'ı in-place yap, tek GLB'de birleştir.
3. `optimize.ts`: **gltf-transform** ile `dedup → prune → weld → simplify (gerekirse) → resample → quantize → meshopt` (Draco değil, meshopt; decoder küçük). Dokular **KTX2 (ETC1S/UASTC)**, palette tabanlı shading nedeniyle çoğu dokusuz kalabilir.
4. `validate.ts`: glTF-Validator, tri/bone/texture bütçe kontrolü, `licenses.json`'da kaydı olmayan asset varsa **build fail**.
5. Çıktı: `public/assets/*.glb` + `public/assets/manifest.json` (hash'li isimler).

---

## 5. Teknik mimari

### 5.1 Stack
- **Bun** (install/scripts), **Vite 6+**, **TypeScript strict**
- **three.js r170+** (WebGL2 hedef; WebGPU bu demo için kapsam dışı ama renderer arkası soyutlanmalı)
- `three-mesh-bvh` (zemin raycast ve kamera çarpışması)
- Fizik: **yok**. Kendi basit kinematik controller (kapsül ve heightfield/navmesh kısıtları). Gerekirse `recast-navigation-js` (düşman navigasyonu, MIT).
- Ses: **Web Audio API** üzerine ince katman (Howler kullanılabilir ama gereksiz; tercih: kendi `AudioEngine`)
- UI: DOM + CSS (HUD, menüler). Framework yok ya da **Preact** (çok küçük). Font: lisanslı OFL comic font (ör. "Bangers" OFL, "Comic Neue" OFL, doğrula).
- PWA: `vite-plugin-pwa` (Workbox), precache tüm demo asset'leri
- Test: **Vitest** (birim), **Playwright** (e2e ve screenshot, mobil emülasyon)
- Lint/format: Biome (ya da ESLint + Prettier)
- CI: GitHub Actions (typecheck, lint, test, build, bundle-size check, Playwright smoke)

### 5.2 Klasör yapısı
```
inkwake/
  PLAN.md  CLAUDE.md  README.md  LICENSE  CREDITS.md
  reference/poc/            # POC index.html (+ wizard-model.js)
  docs/ASSET_RESEARCH.md  docs/PERF.md  docs/DEVICE_TESTS.md
  assets/source/  assets/licenses.json
  scripts/ fetch-assets.ts retarget.ts optimize.ts validate.ts blender/
  public/ assets/ icons/ manifest.webmanifest
  src/
    main.ts
    core/      loop.ts time.ts input/ (touch, keyboard, gamepad) events.ts storage.ts
    render/    renderer.ts post/ (inkPost.ts, pageTurn.ts, panels.ts) materials/ (InkMaterial.ts, chunks/*.glsl) reveal/ (RevealSystem.ts) quality.ts
    world/     level loader, Level1..3.ts, Boss.ts, props, procedural trees, ground
    entities/  Player.ts, enemies/ (Smudge, Scribbler, Blot), Editor/ (boss FSM)
    systems/   combat.ts, ink-energy.ts, sketch-objects.ts, spawner.ts, checkpoints.ts, ai/
    fx/        particles.ts, onomatopoeia.ts, screenShake.ts
    audio/     AudioEngine.ts, music.ts (layered, faz bazlı), sfx bank
    ui/        hud/, menus/ (Title, Pause, Settings, Credits, Cover/Share), i18n/ (tr.json, en.json)
    data/      tuning.ts (tüm sayılar burada, tek yerden ayar)
    debug/     lil-gui panel (?debug=1), stats, free cam
  tests/ unit/ e2e/
```

### 5.3 Mimari ilkeler
- **Tek yönlü game loop:** fixed-step simülasyon (60 Hz) + değişken render, interpolasyon.
- Sahne durumları: `Boot → Title → Playing(PageN) → PageTurn → Boss → Cover → Credits`; durum makinesi `core/state.ts`.
- Hafif ECS-lite (entity = class + component objeleri). Abartma.
- Tüm tuning değerleri `data/tuning.ts`'de, debug panelden canlı ayarlanabilir.
- Level'lar veri odaklı: `Level1.ts` = spline yol + spawn noktaları + sketch objeleri + tetikleyiciler (JSON benzeri TS objeleri).
- Kaydetme: `localStorage` (try/catch): ayarlar, en son checkpoint, en iyi süre.
- Hata dayanıklılığı: WebGL context lost/restored handling, asset load hatasında retry ve hata ekranı, `visibilitychange`'de otomatik pause ve ses suspend, audio unlock ilk dokunuşta.

---

## 6. Kontroller ve UX detayları
- Dikey yön birincil. `viewport-fit=cover`, safe-area insets (çentik), `touch-action:none`, uzun basma menüsü ve seçim engelli, pull-to-refresh kapalı (`overscroll-behavior:none`).
- Sanal joystick: sol yarı, dinamik merkez, ölü bölge %12, görsel ink halka.
- Sağ yarı: tap = bolt, hold = kristal, swipe = dash (gesture ayırma: tap < 180 ms ve < 12 px; hold > 180 ms; swipe > 40 px / 200 ms).
- Masaüstü: WASD/oklar, Space = dash, Mouse sol = bolt, Mouse sağ ya da Shift (basılı) = kristal. Gamepad desteği (Gamepad API).
- Haptik: `navigator.vibrate` (Android). iOS'ta yok, sessizce atla.
- HUD: sol üstte sayfa-can, altında mürekkep şişesi enerji barı (sıvı shader), sağ üstte pause. Minimal ve çizgi roman dilinde.
- Tutorial yazısız: dokunma ikon animasyonları, ilk 30 sn'de ekranda elle çizilmiş oklar.
- Yükleme ekranı: kâğıt üzerine kalemle çizilen INKWAKE logosu, gerçek progress'e bağlı.
- Ana menü: "Read Issue #1" (oyna), Settings, Credits. Arka planda canlı sahne.

---

## 7. Ses tasarımı
- **Müzik:** katmanlı (stems) dark-fantasy ambient. Keşif = pad + kalem çizim dokusu; savaşta perküsyon katmanı fade-in; boss için ayrı parça ve 3 faz yoğunluğu. Lisanslı kaynaktan; bulunamazsa uygun CC0 parçalar + Web Audio ile prosedürel katman (drone, kâğıt hışırtısı).
- **SFX listesi (minimum):** kristal aç/kapat (ıslak mürekkep "shhh"), ink bolt fire/impact, dash whoosh, hayalet ortaya çıkış (kâğıt hışırtı), hayalet ölümü (kâğıt yırtılma), oyuncu hasarı (sayfa yırtılma), mürekkep toplama (damla), çizdirme döngüsü (kalem çiziktirme loop) ve tamamlanma (damga "thunk"), sayfa çevirme, adımlar (çim/taş), boss silgi sürtünmesi, boss kükremesi, panel kesmesi stinger, UI tık/hover, final fanfar.
- Mix: tüm SFX'ler -1 dBFS peak, LUFS hedef ~-16 integrated; master'da compressor/limiter (DynamicsCompressorNode).
- Format: **Opus/WebM + AAC/M4A fallback** (iOS Safari için) ya da sadece AAC. Kısa SFX'ler tek audio sprite'ta.
- Spatial: basit stereo panning ve mesafe attenuation (PannerNode HRTF mobilde pahalı, `equalpower` kullan).

---

## 8. Performans bütçeleri (kabul kriteri)
| Metrik | Hedef |
|---|---|
| FPS | iPhone 12 / Pixel 6 sınıfı: **60 fps** sabit. Orta segment Android (ör. Galaxy A54): ≥ 45 fps, alt sınır 30. |
| İlk yükleme (gzip/brotli) | JS < **350 KB**, toplam ilk indirme < **8 MB**, ilk oynanabilir an < 4 sn (4G). Sayfa 2–3 ve boss asset'leri arka planda stream edilir. |
| Draw call | < 120 / frame |
| Görünür tri | < 200k |
| Skinned mesh | aynı anda ≤ 10. Düşmanlar **instanced** ve vertex-animasyonlu (VAT ya da shader deform). |
| Doku belleği | < 64 MB GPU |
| Pixel ratio | Adaptif: 1.0–2.0 arası, frame süresine göre dinamik çözünürlük (`quality.ts`). Post-process gerekirse yarım çözünürlükte. |
| GC | Oyun sırasında frame başına allocation yok (vektör havuzları). |
| Bellek | JS heap < 150 MB |

`docs/PERF.md`'ye her milestone'da ölçüm tablosu eklenir (cihaz, fps p50/p95, draw calls, tri).

---

## 9. PWA ve dağıtım
- `manifest.webmanifest`: name, short_name, ikonlar (192, 512, maskable), `display: fullscreen`, `orientation: portrait`, theme/background renkleri palette'den.
- Service worker: precache (demo tamamen offline oynanır), versiyonlu cache ve "Yeni sürüm hazır, yenile" toast'u.
- iOS: `apple-touch-icon`, `apple-mobile-web-app-capable`, splash screens.
- "Ana ekrana ekle" prompt'u: oyun bitiminde nazikçe göster.
- Deploy: statik (Cloudflare Pages / GitHub Pages / Netlify). `bun run build` → `dist/`. Doğru MIME tipleri (`.ktx2`, `.glb`, `.webmanifest`) ve uzun cache header'ları.
- Analytics: yok (gizlilik). Sadece opsiyonel, lokal performans log'u.

---

## 10. Kalite çıtası ("production quality" tanımı)
Demo tamamlanmış sayılmadan önce **hepsi** sağlanmalı:
- [ ] Konsolda hata ya da uyarı yok (prod build).
- [ ] Baştan sona 3 tam oynanışta crash, softlock ya da collision'dan düşme yok.
- [ ] Ölüm ve checkpoint akışı, pause/resume, arka plana alıp geri dönme, ekran döndürme, context loss sorunsuz çalışıyor.
- [ ] Tüm metinler TR ve EN.
- [ ] Ses ilk dokunuşta açılıyor, sessiz moddaki iPhone'da beklenen davranış gösteriliyor.
- [ ] Safe-area, çentik, farklı oranlar (19.5:9, 20:9, 4:3 iPad, masaüstü 16:9) doğru framing'de.
- [ ] Credits ekranı ve `CREDITS.md`, `licenses.json` ile birebir.
- [ ] Lighthouse PWA "installable", performans ≥ 85 (mobil).
- [ ] Perf bütçeleri (§8) en az 1 iOS ve 1 Android cihazda ölçülüp `docs/PERF.md`'de.
- [ ] Görsel tutarlılık: palette dışı renk yok (debug modda "palette violation" overlay'i ile kontrol), placeholder asset kalmadı.
- [ ] Oynanış süresi ilk oyuncu için 5–8 dk (playtest ile doğrula; deneyimli oyuncuda ≥ 4 dk).

---

## 11. Milestone'lar (sırayla, her biri commit'lenir ve doğrulanır)

### M0: Repo iskeleti (0.5 gün)
Bun + Vite + TS strict, Biome, Vitest, Playwright, CI, `reference/poc/` (POC kopyalanır), debug panel, boş sahne ve loop.
**Kabul:** `bun run dev|build|test|e2e` çalışıyor, CI yeşil.

### M1: Asset araştırması ve pipeline (1–1.5 gün)
§4.1 araştırması, `ASSET_RESEARCH.md`, `licenses.json`, fetch/retarget/optimize/validate script'leri. Büyücü ve tüm animasyonlar tek optimize GLB'de.
**Kabul:** `bun run assets` sıfırdan çalışıp `public/assets`'i üretiyor; validate geçiyor; lisanssız asset build'i kırıyor.

### M2: Render çekirdeği (1.5–2 gün)
InkMaterial (skinning/instancing), reveal sistemi, outline (A/B), birleşik post pass, line boil, kalite ayarları. POC sahnesini yeni sistemle yeniden üret.
**Kabul:** POC ile yan yana screenshot karşılaştırması (`tests/e2e/visual.spec.ts`); reveal sızması görsel olarak kenarda wobble ve ıslak mürekkep gösteriyor; mobilde 60 fps.

### M3: Oyuncu ve kontroller (1 gün)
Kinematik controller, kamera, touch/keyboard/gamepad, kristal, bolt, dash, animasyon state machine (12 fps step).
**Kabul:** Test arenasında tüm hareketler mobil emülasyonda ve gerçek cihazda akıcı.

### M4: Düşmanlar ve combat (1.5 gün)
Smudge, Scribbler, Blot; hasar ve can; mürekkep enerjisi; spawner; VFX; panel kesmesi sistemi.
**Kabul:** Test arenasında 8 düşmanla 60 fps; panel kesmesi tetiklenebiliyor.

### M5: Level'lar 1–3 (2 gün)
Procedural orman ve prop yerleşimi, sketch objeleri (köprü, merdiven, kapı), checkpoint'ler, sayfa çevirme geçişleri, tutorial ipuçları.
**Kabul:** Sayfa 1'den 3'e kesintisiz oynanış, süre ~4.5 dk.

### M6: Boss THE EDITOR (1.5 gün)
3 fazlı FSM, silme mekaniği (reveal history'yi kalıcı kapatma), zayıf nokta çizdirme, faz panel kesmeleri, boss müziği.
**Kabul:** Boss 2–2.5 dk'da yenilebiliyor (Normal); Story modda kolay.

### M7: UI, ses ve meta (1.5 gün)
Title, Pause, Settings, Credits, Cover ve Share ekranları; i18n; AudioEngine, müzik katmanları, tüm SFX; haptik; kaydetme.
**Kabul:** Tüm ekranlar TR/EN; ses mix dengeli; paylaşım PNG'si doğru.

### M8: PWA, perf ve cila (1.5–2 gün)
Service worker, ikonlar, splash, adaptif kalite, perf ölçümü, bug bash, juice (hit-stop, screen shake, squash), erişilebilirlik ayarları.
**Kabul:** §10 checklist'in tamamı.

Toplam tahmin: ~12–14 iş günü (Claude Code oturumları olarak bölünür).

---

## 12. Test stratejisi
- **Unit (Vitest):** gesture ayırıcı, enerji sistemi, hasar hesapları, boss FSM geçişleri, reveal maske matematiği (CPU tarafı), lisans validator.
- **E2E (Playwright):** iPhone 14 ve Pixel 7 emülasyonu. Boot → Title → oyun başlat → `?autoplay=1` bot modu (debug: oyuncuyu spline boyunca yürütüp düşmanlara otomatik ateş eden bot) → boss → cover. Her sayfa sonunda screenshot ve görsel regresyon (eşik %2).
- **Perf smoke:** Playwright'ta `?bench=1` ile 30 sn sabit kamera turu, ortalama frame süresi log'lanır; CI'da kaba eşik.
- **Manuel cihaz testi:** `docs/DEVICE_TESTS.md` checklist (iOS Safari, iOS PWA kurulu, Android Chrome, Android PWA, masaüstü Chrome/Firefox/Safari).

---

## 13. Debug araçları (`?debug=1`)
lil-gui (tüm tuning ve shader uniform'ları), FPS/draw-call/tri sayacı (stats-gl), free cam, sayfa atla (1/2/3/boss), god mode, reveal maskesini göster, palette violation overlay, düşman spawn butonu, panel kesmesi tetikle, 12 fps boil aç/kapat.

---

## 14. Riskler ve önlemler
| Risk | Önlem |
|---|---|
| Uygun boss ya da hayalet modeli bulunamaz | Procedural mesh ve vertex animasyon fallback'i (§4.1). Boss için UAL retarget + ölçek + kâğıt/eskiz shader zaten stili taşır. |
| Retarget bozuklukları (A/T pose, ölçek) | Blender headless retarget script'i, rest pose normalizasyonu, test sahnesinde tüm klipler için görsel kontrol. |
| Mobilde post-process pahalı | Tek birleşik pass, yarım çözünürlük, Low kalitede outline sadece inverted hull. |
| iOS ses kısıtları | Ses ilk dokunuşta unlock edilir, AAC fallback, `visibilitychange` ile suspend/resume. |
| Reveal history RT maliyeti | 256² ve frame atlamalı güncelleme; Low'da sadece anlık yarıçap. |
| Lisans hatası | validate script'i build'i kırar, `CREDITS.md` otomatik üretilir. |
| Süre hedefi kayar | Tuning'den düşman sayısı/HP ve yol uzunluğu ayarlanır; playtest süresi log'lanır. |

---

## 15. Kapsam dışı (bu demo için)
Multiplayer, hesap/backend, IAP, WebGPU renderer, Issue #2 içeriği, native mağaza build'leri (Capacitor ileride), kullanıcı üretimi içerik.

---

## 16. Claude Code çalışma talimatları
1. **İşe bu dokümanı okuyarak başla**, sonra `reference/poc/index.html`'i incele (shader ve paletin kaynağı).
2. Milestone'ları **sırayla** yap. Her milestone sonunda: typecheck, lint, test, build ve Playwright screenshot. Ardından görsel çıktıyı **kendin aç ve incele** (screenshot'ı oku), sonra commit at (`feat(m2): ...`).
3. Asset kararlarını `docs/ASSET_RESEARCH.md`'ye gerekçesiyle yaz. Lisansı doğrulamadan hiçbir asset'i repoya ekleme.
4. Görsel kararlarda POC'nin estetiğinden sapma. Emin değilsen iki varyantı debug panelde toggle'lanabilir yap ve screenshot karşılaştırmasıyla seç.
5. Sayıları koda gömme, `data/tuning.ts` kullan.
6. Mobil öncelik: her özelliği önce mobil emülasyonda test et.
7. Takıldığın ya da geri dönüşü zor bir karar (lisans belirsizliği, büyük kapsam değişikliği) olduğunda dur ve sor. Diğer her şeyde makul varsayımı yap ve commit mesajında/`docs/DECISIONS.md`'de not et.
8. Gizli bilgi, API key ya da login gerektiren indirme varsa otomatikleştirme; README'ye manuel adım yaz.

---

## 17. `CLAUDE.md` (repo köküne, kısa hali)
```md
# INKWAKE
Mobile-first PWA, three.js r170+, TS strict, Bun + Vite. Full plan: PLAN.md (source of truth).
- Visual reference: reference/poc/index.html — keep palette/ramps exact (ColorManagement off).
- Every asset must be in assets/licenses.json (commercial use allowed). `bun run assets:validate` must pass.
- All gameplay numbers live in src/data/tuning.ts.
- Perf budgets in PLAN.md §8 are acceptance criteria. No per-frame allocations.
- After each milestone: bun run typecheck && bun run lint && bun test && bun run build && bun run e2e, inspect screenshots, then commit.
- Debug: ?debug=1, ?autoplay=1, ?bench=1, ?page=N
- Ask before irreversible or license-ambiguous decisions; log other decisions in docs/DECISIONS.md.
```

---

## 18. Handover için kullanıcı adımları
1. Yeni boş repo aç (ör. `~/Workspace/inkwake`).
2. Bu dosyayı `PLAN.md` olarak koy.
3. POC artifact'ından `index.html` ve `wizard-model.js` dosyalarını `reference/poc/` altına koy.
4. Claude Code'a ilk prompt:
   > "PLAN.md'yi ve reference/poc/'u oku. M0'dan başla ve milestone'ları sırayla tamamla. Her milestone sonunda doğrula, commit at ve bana kısa rapor ver. M1'deki asset araştırmasını derin yap: her lisansı resmi kaynağından doğrula."

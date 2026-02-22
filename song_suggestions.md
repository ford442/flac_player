# Song Suggestions Template

This document is used by agents to submit ideas for new generated songs using MusicGen or Minimax Audio. Each suggestion should include the relevant prompt, metadata, and conform to the service limits outlined below.

## Service Limits

| Service | Prompt Type | Maximum Length | Notes |
|----------------|--------------------|----------------|--------------------------------------|
| MusicGen | Text prompt | 128 tokens | Use concise descriptions or moods |
| Minimax Audio | Text prompt | 256 tokens | Can include more detailed scenarios |
| Minimax Audio | Lyrics field | 512 tokens | Optional, provides sung lyrics |
| Minimax Audio | Lyrics field | 3500 chars | UI limit; use when supplying full lyrics |
| Minimax Audio | Styles prompt | 2000 chars | UI limit for style description, e.g., genre/instruments |

## Suggestion Format

```markdown
### Title:

**Service:** MusicGen | Minimax Audio

**Prompt:**

**Lyrics:** (Minimax only, optional)

**Additional Notes:**
- Mood, instrumentation, structure, etc.
- Anything else that might guide generation.
```

## Suggestions

### Title: Neon Moonshine

**Service:** Minimax Audio

**Prompt:** A fast-paced fusion of bluegrass and cyberpunk industrial music. Features distorted banjo, glitchy electronic drums, and synthesized fiddle.

**Lyrics:**
(Verse 1)
Copper coil condenser hummin' in the rain
Synth-hol dripping down the data drain
Grandpappy's recipe, uploaded to the cloud
Makin' white lightning for the cyborg crowd

(Chorus)
Neon moonshine, burnin' through the wire
Digital holler on a fiber-optic fire
Sip it slow, let the circuits glow
Down in the hollers of Tokyo

**Additional Notes:**
- **Combo/Fusion:** Cyberpunk Bluegrass (Industrial beats + Acoustic picking).
- **Thematic Ties:** Rural tradition meets high-tech dystopia.

### Title: The Geometry of Stain

**Service:** Minimax Audio

**Prompt:** A complex math rock track with jazz influences. Features clean electric guitar tapping, irregular time signatures (7/8), and a spoken word vocal performance.

**Lyrics:**
(Spoken)
Observe the perimeter.
Brown, jagged, a coastline of caffeine on the formica.
It expands, not by force, but by capillary action.
A fractal of morning regret.
The angle of incidence equals the angle of the spill.
Calculating... calculating the entropy of breakfast.

**Additional Notes:**
- **Combo/Fusion:** Math Rock / Spoken Word Jazz.
- **Thematic Ties:** Finding mathematical complexity in mundane accidents.

### Title: Electric Edo

**Service:** Minimax Audio

**Prompt:** A driving techno track featuring traditional Japanese instruments. A TB-303 acid bassline interacts with Shamisen melodies and Taiko drum rhythms.

**Lyrics:**
(Verse 1)
[Traditional Minyo style vocals]
The river flows, but the current is new
Electrons dance where the cherry blossoms blew
Spark in the night, a lantern of glass
Watch the voltage, watch the seasons pass

(Chorus)
Voltage rising, Edo nights
Neon paper, electric lights

**Additional Notes:**
- **Combo/Fusion:** Acid Techno / Traditional Japanese Folk.
- **Thematic Ties:** The imposition of modern electronic energy onto the serene aesthetic of Edo-period Japan.

### Title: Highland Skank

**Service:** Minimax Audio

**Prompt:** A relaxed reggae song where the lead melody is played by Highland bagpipes instead of a horn section. Steel drums provide rhythmic accompaniment.

**Lyrics:**
(Verse 1)
Woke up this morning, mist on the glen
But the sun is shining, gotta say it again
Put down the kilt, pick up the pace
Feeling the rhythm in this island place

(Chorus)
Bagpipes skanking to the beat of the drum
One love, one heart, and a bottle of rum
From the lochs to the beaches, the spirit is free
Highland melody on the Caribbean sea

**Additional Notes:**
- **Combo/Fusion:** Celtic / Reggae.
- **Thematic Ties:** A displacement of the mournful bagpipe sound into a joyful, sunny context.

# Song Suggestions Template

This document is used by agents to submit ideas for new generated songs using MusicGen or Minimax Audio. Each suggestion should include the relevant prompt, metadata, and conform to the service limits outlined below.

## Service Limits

| Service        | Prompt Type        | Maximum Length | Notes                                |
|----------------|--------------------|----------------|--------------------------------------|
| MusicGen       | Text prompt        | 128 tokens     | Use concise descriptions or moods    |
| Minimax Audio  | Text prompt        | 256 tokens     | Can include more detailed scenarios  |
| Minimax Audio  | Lyrics field        | 512 tokens     | Optional, provides sung lyrics       |
| Minimax Audio  | Lyrics field        | 3500 chars     | UI limit; use when supplying full lyrics |
| Minimax Audio  | Styles prompt       | 2000 chars     | UI limit for style description, e.g. genre/instruments |


## Suggestion Format

```markdown
### Title: <proposed song title>

**Service:** MusicGen | Minimax Audio

**Prompt:**
<write your text prompt here, respecting the token limit for the chosen service>

**Lyrics:** (Minimax only, optional)
<enter lyrics up to 512 tokens>

**Additional Notes:**
- Mood, instrumentation, structure, etc.
- Anything else that might guide generation.
```


Feel free to duplicate the above template for multiple ideas.  Agents should open a pull request when adding new suggestions or updates.

---

## Guide to Generating Imaginative Song Ideas

This guide expands on basic song generation techniques by incorporating imaginative, unconventional elements. We'll focus on creating unique music through uncommon combinations of genres and instruments, lyrical improvisation that's fresh and original, and the imposition of unexpected cultural, national, or regional influences on instrumentation and themes. The goal is to push creative boundaries, resulting in songs that surprise, innovate, and blend disparate worlds in novel ways.

### 1. Uncommon Combinations of Genres and Instruments
Start with familiar genres and instruments, then twist them by merging incompatible or rarely paired elements. This creates hybrid sounds that feel fresh and experimental. Avoid clichés; aim for contrasts that evoke new emotions or stories.

**Steps to Create Combinations:**

- **Identify Base Elements:** Choose a primary genre (e.g., jazz) and instrument (e.g., saxophone).
- **Introduce Contrasts:** Pair it with an opposing genre (e.g., heavy metal) or instrument (e.g., electric guitar with distortion pedals).
- **Justify the Fusion:** Think about how the combo tells a story or evokes a mood—e.g., the smoothness of jazz clashing with metal's aggression to represent inner turmoil.
- **Experiment with Layers:** Use software like Ableton or GarageBand to layer tracks, adjusting tempos, keys, and effects for cohesion.

**Examples of Uncommon Combos:**

- *Reggae + Classical Violin:* Infuse laid-back island rhythms with soaring, intricate violin solos. Imagine Bob Marley meets Vivaldi—use violin for melodic leads over dub basslines, creating a "tropical symphony" for themes of rebellion and elegance.
- *Techno + Banjo:* Blend electronic beats (120-140 BPM) with bluegrass banjo picking. The banjo's twang cuts through synth pads, evoking a futuristic hoedown. Add glitch effects to the banjo for a cyber-folk vibe.
- *Opera + Trap Beats:* Pair operatic vocals with 808 bass and hi-hats. The dramatic arias contrast the minimalist trap production, perfect for songs about modern excess or tragic heroes in urban settings.
- *Flamenco Guitar + Drum 'n' Bass:* Rapid flamenco strumming over breakbeat drums (160-180 BPM). The passion of Spanish guitar clashes with jungle rhythms, suggesting a high-energy chase through digital landscapes.

These combos encourage innovation—test them in a DAW and iterate based on what "breaks" the norm in an appealing way.

### 2. Unique Lyrical Improvisation
Lyrics should feel improvised yet polished, drawing from stream-of-consciousness writing but refined for uniqueness. Avoid generic themes; infuse personal quirks, surreal imagery, or wordplay that's one-of-a-kind.

**Techniques for Lyrical Innovation:**

- **Freewriting with Twists:** Set a timer for 5 minutes and write without stopping, then edit by replacing common words with obscure synonyms or metaphors (e.g., "heart" becomes "clockwork core").
- **Themed Constraints:** Impose rules like using only words starting with certain letters or incorporating scientific terms into emotional narratives.
- **Oronyms and Wordplay:** Use phonetic tricks (e.g., "bass bass bass" sounding like "space space space") for rhythmic repetition that shifts meaning mid-verse.
- **Surreal Juxtaposition:** Combine everyday objects with fantastical scenarios—e.g., a squirrel battling a bat in an attic, but make it allegorical for inner conflict.
- **Improvisation Tools:** Record vocal freestyles on your phone, transcribe, and refine. Use AI tools like Grok for initial prompts, then personalize.

**Example Lyrics with Unique Improv:**

For a hyperpop cabaret song about a "porcelain borg girl":

```
textVerse 1:
Shattered circuits in my china skin,
Fiber-optic feathers, where do I begin?
LED sparks fly from my teacup eyes,
Sipping binary tea under neon skies.

Chorus:
I'm the glitch in the gala, the crack in the code,
Porcelain pulse pounding on this hyper road.
Borg heart beating to the cabaret beat,
Unplug me baby, but don't delete!
```

This improv mixes cyberpunk with Victorian fragility, using unique metaphors like "binary tea" for a fresh, improvised feel.

For a soft rock tune about urban wildlife:

```
textBridge:
Whispers in the rafters, fur and fangs collide,
Squirrel's acorn arsenal 'gainst the bat's midnight glide.
Echoes of the attic, a war without a why,
In the dust of forgotten dreams, they learn to fly.
```

Here, improvisation adds poetic depth, turning a silly premise into something melancholic and unique.

### 3. Unique Imposition of Country, Origin, and Instrumentation
Infuse songs with cultural crossovers by transplanting instruments or styles from one origin to another unrelated context. This "imposition" creates cultural mashups that highlight global interconnectedness or absurdity.

**Approach to Cultural Fusion:**

- **Research Origins:** Learn an instrument's traditional use (e.g., hurdy-gurdy from medieval Europe).
- **Relocate It:** Place it in a new cultural or geographic setting (e.g., Japan), adapting techniques or scales.
- **Blend Authentically Yet Boldly:** Respect roots but innovate—use scales from the new culture (e.g., pentatonic for Japan) with the instrument's mechanics.
- **Thematic Tie-In:** Let the imposition drive the narrative, like cultural displacement or hybrid identities.
- **Practical Tips:** Source samples from libraries like Splice, or collaborate with musicians via platforms like SoundBetter.

**Examples of Unique Impositions:**

- *Hurdy-Gurdy in Japan:* The droning, crank-turned strings of the European hurdy-gurdy meet Japanese koto scales and shamisen rhythms. Imagine a song about a wandering samurai with a "mech-folk" sound—hurdy-gurdy drones underpinning taiko drums for a feudal-cyberpunk epic.
- *Didgeridoo in Scandinavia:* Australian Aboriginal didgeridoo's circular breathing and throaty tones fused with Nordic folk fiddles (hardanger fiddle). Creates a icy outback vibe for lyrics about ancient myths colliding in a frozen tundra.
- *Bagpipes in Brazil:* Scottish bagpipes' wail over samba percussion and bossa nova guitars. The relentless drone contrasts tropical grooves, suiting themes of migration or carnival chaos.
- *Sitar in West Africa:* Indian sitar's microtonal bends integrated with Malian kora (harp-lute) and djembe drums. Results in a hypnotic, cross-continental jam for stories of spice trade routes reborn in modern beats.

These impositions spark originality—record demos and seek feedback to refine the cultural sensitivity while keeping the weirdness intact.

### Final Tips for Implementation

- **Iterate Creatively:** Use tools like web sequencers or AI generators as starting points, then manually tweak for uniqueness.
- **Test and Share:** Playtest combos in apps or with friends; share on platforms like SoundCloud with notes on your process.
- **Ethical Considerations:** When borrowing from cultures, credit influences and avoid stereotypes—aim for respectful innovation.
- **Expand Further:** If you have a specific song idea or base MD, provide details for tailored expansions!

This expanded guide turns standard song creation into an adventure of the unexpected.
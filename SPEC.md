# MP3 Cutter and Audio Trimmer — specification

**Tagline:** Cut and trim MP3, WAV and M4A clips with a waveform in your browser, with nothing uploaded.

**Category:** Audio & Video

**Free alternative to:** MP3 Cutter at mp3cut.net (ad-heavy page, pushes an online editor with sign-up for extras, sends large files through a web page you must trust)

**Search phrases:** mp3 cutter, cut mp3 online, audio trimmer, trim audio online, ringtone maker, cut audio file, mp3 cutter no upload

**Allowed libraries:** lamejs

**Published at:** https://turhe123.github.io/mp3-cutter-local/

## Acceptance checks (each must have a test)

- Dropping sample-song.mp3 draws a waveform with two draggable trim handles
- Setting start 00:05.0 and end 00:15.0 and pressing Cut downloads an MP3 about 10 seconds long
- The result shows the new duration and file size
- Fade in and fade out toggles change the exported audio without errors
- A non audio file shows a clear error message and no crash
- The layout works at 390px wide

## Spec

People search for mp3 cutter, audio trimmer and ringtone maker every day. The leading sites are free but surround the tool with ads, nudge you toward a sign-up or an app for fades and formats, and make you hand over personal recordings such as voice notes, interviews or unreleased music to a site you do not control. Our version does exactly one job: pick a section of an audio file and save only that section.

Feature set: load one audio file (MP3, WAV, M4A, OGG, FLAC as far as the browser can decode). Show a waveform. Let the user drag a start handle and an end handle, or type exact times. Provide a play preview of the selected region, optional fade in and fade out of a chosen length (default 0 seconds), and an option to delete the selection instead of keeping it. Export as MP3 (default, 128 kbps with a 96, 128, 192, 256, 320 choice) or WAV. Nothing else: no joining, no effects.

UI: above the fold is a large drop zone with a choose file button. After loading, the waveform fills the width with the handles, a time readout for start, end and length, a play and stop button, and the options row. The Cut and save button is primary. After export show the output duration, size and a download link named after the original file with the suffix cut. Empty state explains supported formats. Errors for undecodable files are shown inline in plain words. Keyboard: space toggles play, left and right arrows nudge the active handle by 0.1 seconds, shift makes it 1 second.

Technical approach: read the file with the File API, decode with AudioContext decodeAudioData into an AudioBuffer. Draw the waveform by computing min and max per pixel column onto a canvas, scaling for device pixel ratio. Preview using an AudioBufferSourceNode started at the start offset with a stop time. For export, copy the selected frames into a new buffer, apply gain ramps for fades, convert Float32 to Int16 and encode with lamejs in a Web Worker in chunks of 1152 samples to keep the page responsive, or write a simple 16 bit PCM WAV header by hand. Join the encoded chunks into a Blob and offer it with an object URL, revoking it afterwards. Mono and stereo are both supported, and the sample rate of the source is kept.

Edge cases: very long files such as two hour podcasts can use a lot of memory once decoded, so warn above roughly 200 MB of source and suggest a shorter file. Mobile Safari needs the audio context resumed after a user tap, so create it inside the click handler. Some browsers cannot decode certain M4A or FLAC files, so show a friendly message. Start must be smaller than end, and handles are clamped. File names with Unicode characters must be preserved in the download name.

Demo data: a bundled ten second generated sample made from three sine tones with a quiet gap, described as Sample Song by Demo Band, so the waveform shows visible sections to cut.

# Regional Water — experimental proof of concept

Built on [Draiget/faf-re](https://github.com/Draiget/faf-re), based on commit `6a4ed10b5e3af6114ae7b909c2531ca66ef263e0`. Thanks to Draiget and contributors. [Demo video](https://www.youtube.com/watch?v=UmmmxQOOND8).

This prototype adds multiple polygon and rectangular water regions at different elevations. It updates local water queries in simulation, water rendering, collisions and selected AI and gameplay paths. The editor exports a `.scmap.regionalwater` sidecar alongside a map. It does not modify the SCMAP.

**Status:** D3D9 tested. Ships, submarines, torpedoes, transports and AI have been exercised in game; a short two-PC LAN game had no observed desync. This does not establish long-term multiplayer compatibility. The FAF client, replay and save integration are not complete. Both players need the same modified engine and map files.

At most eight separate regions are supported, polygons have 3–32 vertices, and polygons preserve existing map terrain. Some water rendering effects and interactions remain experimental. See `editor/README_DEV.md`.

## Example

Open `editor/Regional_Water_Editor.html` in a browser. Click Open map and choose `example-map/Water_Height_Test.v0001/Water_Height_Test.scmap`, then Load regions and choose its adjacent `.scmap.regionalwater` file. To play, copy the whole map folder to the isolated test game's Maps directory and use the modified engine. You need your own game and FAF data.

The engine includes the upstream net_Lag default correction from commit `92e5465c461f8dda09d6c15bb15e14eb78ef6f59`. This project is an experiment and is not an official FAF release.

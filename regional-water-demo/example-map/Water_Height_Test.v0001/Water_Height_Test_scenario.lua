version = 3 -- Lua Version. Dont touch this
ScenarioInfo = {
    name = "Water_Height_Test",
    description = "Testing multiple heights of water.",
    preview = '',
    map_version = 1,
    type = 'skirmish',
    starts = true,
    size = {512, 512},
    reclaim = {0, 0},
    map = '/maps/Water_Height_Test.v0001/Water_Height_Test.scmap',
    save = '/maps/Water_Height_Test.v0001/Water_Height_Test_save.lua',
    script = '/maps/Water_Height_Test.v0001/Water_Height_Test_script.lua',
    norushradius = 40,
    Configurations = {
        ['standard'] = {
            teams = {
                {
                    name = 'FFA',
                    armies = {'ARMY_1', 'ARMY_2', 'ARMY_3', 'ARMY_4', 'ARMY_5', 'ARMY_6', 'ARMY_7', 'ARMY_8'}
                },
            },
            customprops = {
                ['ExtraArmies'] = STRING( 'ARMY_17 NEUTRAL_CIVILIAN' ),
            },
        },
    },
}

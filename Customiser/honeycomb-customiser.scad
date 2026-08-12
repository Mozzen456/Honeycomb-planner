/* [General] */

// Number of vertical columns
Number_of_Columns = 5; // [1:13]

// Remove or add borders
Top_Border = false;
Bottom_Border = false;
Left_Border = false;
Right_Border = false;

// Double the thickness of exterior border walls
Double_Outer_Wall_Thickness = false; // [true:Double Thickness, false:Normal Thickness]

// If checked, flips the staggering of hexagons
Flip_Staggering = true;

// Select the color for the preview
Colour = "Silver"; // [Red, Orange, Yellow, Green, Blue, Purple, Pink, Brown, Gray, Black, White, Cyan, Magenta, Lime, Teal, Indigo, Violet, Gold, Silver, Olive]

/* [Column Settings] */

// Quantity of honeycomb hexagons per column
Column_0 = 5; // [0:12] 
Column_1 = 5; // [0:12]
Column_2 = 5; // [0:12]
Column_3 = 5; // [0:12]
Column_4 = 5; // [0:12]
Column_5 = 5; // [0:12]
Column_6 = 5; // [0:12]
Column_7 = 5; // [0:12]
Column_8 = 5; // [0:12]
Column_9 = 5; // [0:12]
Column_10 = 5; // [0:12]
Column_11 = 5; // [0:12]
Column_12 = 5; // [0:12]

/* [Gap Settings] */

// Comma separated list of row numbers to skip (e.g., 2,4,5)
Gap_Column_0 = ""; 
Gap_Column_1 = ""; 
Gap_Column_2 = ""; 
Gap_Column_3 = ""; 
Gap_Column_4 = ""; 
Gap_Column_5 = ""; 
Gap_Column_6 = ""; 
Gap_Column_7 = ""; 
Gap_Column_8 = ""; 
Gap_Column_9 = ""; 
Gap_Column_10 = ""; 
Gap_Column_11 = ""; 
Gap_Column_12 = ""; 

/* [Offset Settings] */

// Shift columns up or down
Column_Offset_0 = 0; // [-13:13] 
Column_Offset_1 = 0; // [-13:13]
Column_Offset_2 = 0; // [-13:13]
Column_Offset_3 = 0; // [-13:13]
Column_Offset_4 = 0; // [-13:13]
Column_Offset_5 = 0; // [-13:13]
Column_Offset_6 = 0; // [-13:13]
Column_Offset_7 = 0; // [-13:13]
Column_Offset_8 = 0; // [-13:13]
Column_Offset_9 = 0; // [-13:13]
Column_Offset_10 = 0; // [-13:13]
Column_Offset_11 = 0; // [-13:13]
Column_Offset_12 = 0; // [-13:13]

/* [Hidden] */
// Everything below this section is hidden from the Customizer

function get_constants() = [
    false,  // fill
    8,      // depth
    20,     // hole_width
    1.8,    // wall_thickness
    100,    // max_grid_width
    100     // max_grid_height
];

constants = get_constants();
fill = constants[0];
depth = constants[1];
hole_width = constants[2];
wall_thickness = constants[3];
max_grid_width = constants[4];
max_grid_height = constants[5];

default_columns = [
    Column_0, Column_1, Column_2, Column_3, Column_4, 
    Column_5, Column_6, Column_7, Column_8,
    Column_9, Column_10, Column_11, Column_12
];

gap_strings = [
    Gap_Column_0, Gap_Column_1, Gap_Column_2, Gap_Column_3, Gap_Column_4,
    Gap_Column_5, Gap_Column_6, Gap_Column_7, Gap_Column_8,
    Gap_Column_9, Gap_Column_10, Gap_Column_11, Gap_Column_12
];

column_offsets = [
    Column_Offset_0, Column_Offset_1, Column_Offset_2, Column_Offset_3, 
    Column_Offset_4, Column_Offset_5, Column_Offset_6, Column_Offset_7,
    Column_Offset_8, Column_Offset_9, Column_Offset_10, Column_Offset_11,
    Column_Offset_12
];

function parse_gaps(str) = 
    str == "" ? [] :
    [for (i = [0:len(str)-1]) 
        if (str[i] != ",") 
            let(num = str[i] == "!" ? 10 : 
                      str[i] == "@" ? 11 : 
                      str[i] == "#" ? 12 :
                      search(str[i], "0123456789")[0]) 
            num != undef ? num : 0
    ];

// Calculated global variables
columns = [for (i = [0:Number_of_Columns-1]) i < len(default_columns) ? default_columns[i] : 0];
hex_inner_r = hole_width/sqrt(3); 
hex_h = hole_width + wall_thickness*2; 
hex_s = hex_h/sqrt(3); 
hex_d = 2*hex_s; 
hex_t = hex_s/2;

// Calculate Side Length for Thick Walls
hex_h_thick = hole_width + (Double_Outer_Wall_Thickness ? 4 : 2) * wall_thickness;
hex_s_thick = hex_h_thick / sqrt(3); 

max_grid_hexagons_x = fill ? floor(max_grid_width/(hex_d-hex_t) + (Left_Border?0.5:0) + (Right_Border?0.5:0)) : len(columns);
max_grid_hexagons_y = fill ? floor(max_grid_height/hex_h + (Top_Border?0.5:0) + (Bottom_Border?0.5:0)) : max(columns);
max_grid_hexagons_y_lo = fill ? floor(max_grid_height/hex_h - 0.5 + (Top_Border?0.5:0) + (Bottom_Border?0.5:0)) : (max(columns) - 0.5);
total_width = max_grid_hexagons_x * (hex_d-hex_t) + hex_t;
total_height = hex_h * max(max_grid_hexagons_y - 0.5, max_grid_hexagons_y_lo);

color(Colour)
translate([-total_width/2, total_height/2, 0])
grid(columns, column_offsets, gap_strings, depth, hole_width, wall_thickness, fill);

module grid(cols, offsets, gaps, height, hole_width, wall_width, fill){    
    for(hcol = [0:fill?max_grid_hexagons_x-1:(len(cols)-1)]){
        if(fill || cols[hcol] > 0) {
            gap_positions = hcol < len(gaps) ? parse_gaps(gaps[hcol]) : [];
            for(hrow = [0:(fill?(max_grid_hexagons_y-1):(cols[hcol]-1))]) {
                skip = len(gap_positions) > 0 && search(hrow+1, gap_positions) != [] && (!Top_Border || hrow > 0);
                if(!skip){
                    offset_value = hcol>len(offsets)-1?0:offsets[hcol];
                    
                    lo = (hcol+(Flip_Staggering?1:0))%2;
                    x = (hex_d-hex_t) * hcol;
                    y = -hex_h * (hrow + offset_value + lo/2);
                    
                    if(hcol<max_grid_hexagons_x && hrow<(lo==0?max_grid_hexagons_y:max_grid_hexagons_y_lo)){
                        left = Left_Border && hcol==0;
                        top = Top_Border && hrow==0 && hcol%2==(Flip_Staggering?1:0);
                        right = Right_Border && hcol==max_grid_hexagons_x-1;
                        bottom = Bottom_Border && hrow == cols[hcol]-1 && 
                        ((Flip_Staggering && hcol%2 == 0) || 
                            (!Flip_Staggering && hcol%2 == 1));
                            
                        // Full Hexes on the border
                        top_fix = Top_Border && hrow==0 && !top;
                        bottom_fix = Bottom_Border && hrow == cols[hcol]-1 && !bottom;

                        translate([x, y, 0]) halfhex(height, hex_s, wall_width, hole_width, left, top, right, bottom, top_fix, bottom_fix);
                    }
                }        
            }
        }
    }
}

module halfhex(height, radius, wall_thickness, hole_width, left, top, right, bottom, top_fix=false, bottom_fix=false){
    
    // Determine wall thickness for borders
    wt_val = Double_Outer_Wall_Thickness ? 2 * wall_thickness : wall_thickness;
    
    // Shift correction:
    shift = Double_Outer_Wall_Thickness ? wall_thickness : 0;

    difference(){
        union(){
            // Render Hexagon
            hex(height, radius, wall_thickness, hole_width, top_fix, bottom_fix);
            
            // Render Border Walls for CUT hexes
            if(left) translate([0, hex_h/2, 0]) wall(depth, wt_val, hex_h);
            
            // Top Border: Move UP (positive Y) by 'shift'
            if(top) translate([hex_d/2, shift, 0]) rotate([0,0,-90]) wall(depth, wt_val, hex_d);
            
            if(right) translate([0, -hex_h/2, 0]) rotate([0,0,180]) wall(depth, wt_val, hex_h);
            
            // Bottom Border: Move DOWN (negative Y) by 'shift'
            if(bottom) translate([-hex_d/2, -shift, 0]) rotate([0,0,90]) wall(depth, wt_val, hex_d);
        }
        
        // CUTS
        if(left) translate([-hex_d/2, -hex_h, 0]) cube([hex_d/2, 2*hex_h, depth]);
        
        // Top Cut: Move the cut plane UP by 'shift' so we don't slice off the new extended border
        if(top) translate([-hex_d/2, shift, 0]) cube([hex_d, hex_h, depth]);
        
        if(right) translate([0, -hex_h, 0]) cube([hex_d/2, 2*hex_h, depth]);
        
        // Bottom Cut: Move the cut plane DOWN by 'shift' (requires shifting the cube's origin down)
        if(bottom) translate([-hex_d/2, -hex_h - shift, 0]) cube([hex_d, hex_h, depth]);
    }
}

module hex(height, radius, wall_thickness, hole_width, top_fix, bottom_fix){
    // i=4 is Top (270deg), i=1 is Bottom (90deg)
    for(i=[0:5]){
        rotate([0,0,i*60+30])
        
        if (Double_Outer_Wall_Thickness && ((i==4 && top_fix) || (i==1 && bottom_fix))) {
            // THICKENED WALL
            translate([-hole_width/2-wall_thickness*2, hex_s_thick/2, 0])
            wall(height, wall_thickness * 2, hex_s_thick);
        } else {
            // STANDARD WALL
            translate([-hole_width/2-wall_thickness, radius/2, 0])
            wall(height, wall_thickness, radius);
        }
    }
}

module wall(height, wall_thickness, length){
    hmax=height;
    hmin=5.1;
    hd=2;
    tmax=wall_thickness;
    tmin=wall_thickness-1;   
    ft = 0.18;//fillet thickness
    fh = 0.5;//fillet height
    
    difference(){
        rotate([90,0,0])
        linear_extrude(length)   
        polygon([[0,0], [0,hmax], [tmin,hmax], [tmin,hmax-hd], [tmax,hmin], [tmax,fh], [tmax-ft,0]]);
        //Fillet
        rotate([0,0,-30])
        cube([4*tmax, 2*tmax, hmax]);
        mirror([0,1,0])
        translate([0,length,0])
        rotate([0,0,-30])
        cube([4*tmax, 2*tmax, hmax]);
    }
}

"""Prepare 唱片机.blend for the web build and export it as glTF.

Run against a freshly opened copy of 唱片机.blend:

    blender "D:\桌面\A\唱片机.blend" --python tools/export-glb.py

(it is written to be driven over the Blender-MCP bridge as well — it touches
nothing but bpy, and prints a JSON report either way).

Five things, in this order:
  1. names every object and material after what it *is*, so the page can drive
     parts by name instead of by Blender's default 柱体.007;
  2. files the 41 meshes under eight empties — Plinth / Platter / Record / Arm /
     ArmSwivel / ArmMount / Cover / CoverMount — whose origins sit on the axis each
     group moves about. Around the arm there are three, because three different
     things move there: `Arm` swings *and* rises (the cueing lift), `ArmSwivel`
     swings only, and `ArmMount` does neither — the page writes yaw to the first
     two and never writes to the third. `Cover` swings in `CoverMount`, which is
     the same pairing with one axis instead of two;
  3. scales the whole thing into the page's units and puts the deck's top face
     at y = 0, which is what main.js's FLOOR_REST depends on;
  4. exports a GLB next to the page's assets;
  5. prints the numbers the JavaScript side needs.

Two things here are less obvious than they look, and both cost a run:

  * `matrix_parent_inverse` compensates for the *new parent's* world matrix; it
    does NOT re-derive the child's local matrix, which is still expressed
    against the old parent. Setting the inverse alone therefore collapses an
    open dust cover back to flat, and the only sign of it is a bounding box
    that is suddenly 2 units tall. The child's world matrix has to be captured
    before re-parenting and written back after.
  * the group empties want the clean names (Plinth, Platter…), so the meshes
    that would collide with them are the ones that take a suffix.
"""
import bpy, json, os
from mathutils import Vector

D = bpy.data
sc = bpy.context.scene

# ---------------------------------------------------------------- 1. names
OBJ = {
    "立方体":        ("Plinth",  "PlinthBody"),
    "文本":          ("Plinth",  "Brand"),
    "立方体.001":    ("Plinth",  "ControlPlate"),
    "立方体.007":    ("Plinth",  "HingeBracketR"),
    "立方体.008":    ("Plinth",  "HingeBracketL"),
    "柱体.001":      ("Plinth",  "FootFL"),
    "柱体.002":      ("Plinth",  "FootFR"),
    "柱体.003":      ("Plinth",  "FootRL"),
    "柱体.004":      ("Plinth",  "FootRR"),
    "柱体.006":      ("Plinth",  "Control01"),
    "柱体.007":      ("Plinth",  "Control02"),
    "柱体.008":      ("Plinth",  "Control03"),
    "柱体.009":      ("Plinth",  "Control04"),
    "柱体.010":      ("Plinth",  "Control05"),
    "柱体.011":      ("Plinth",  "Control06"),
    "柱体.012":      ("Plinth",  "Control07"),
    "柱体.013":      ("Plinth",  "Control08"),

    "柱体":          ("Platter", "PlatterBody"),
    "柱体.005":      ("Platter", "PlatterRim"),
    "柱体.014":      ("Platter", "Spindle"),

    "柱体.028":      ("Record",  "RecordBody"),

    # --- the tower: bolted to the deck, and it must not swing with the arm ---
    # This split is not cosmetic. All four of these reach well off the bearing
    # axis — the base plate alone reaches 2.0 units from it — so rotating them
    # with the arm sweeps a bolted-down plate through 46°, which is the loudest
    # thing in the frame at the moment you press play. Wrapping the arm in one
    # group and turning it was the first thing that was tried, and this is what
    # it looked like.
    "立方体.002":    ("ArmMount", "ArmBase"),
    # 立方体.006 is not here at all — it is dropped, see DROP below.
    "柱体.015":      ("ArmMount", "ArmCollar"),

    # --- the bearing assembly: it turns with the arm, it does not rise with it
    # Three things move in this model and they are not the same three things.
    # The arm *swings*; when you cue it, the page also lifts the whole `Arm`
    # group by 0.36 units, which is the cueing motion. 立方体.003 and 柱体.016 are
    # the yoke and the vertical shaft the arm hangs in — hardware that turns with
    # the arm (the yoke is a cube 0.417 off the axis, so the turn is visible) but
    # is carried by the tower, so it must not rise. Left in `Arm` it lifted 12.9 mm
    # clear of the collar whenever the deck was paused, which reads as the whole
    # arm detaching from its mount, and only while paused: `armDown` is 1 whenever
    # the deck is playing, and the offset is zero.
    #
    # Hence a third group. `Arm` gets yaw *and* the cue lift; `ArmSwivel` gets yaw
    # only; `ArmMount` gets neither. Same origin for all three — the bearing axis.
    "柱体.016":      ("ArmSwivel", "ArmGimbal"),
    "立方体.003":    ("ArmSwivel", "ArmYoke"),

    # --- the arm proper: everything that swings in that tower ---
    # 立方体.003 used to be listed here, on the grounds that it travels with the
    # arm — which it does, in yaw. It was filed under ArmMount at first because it
    # shares 材质.019 with the base plate and reads as part of the same casting;
    # the material is shared, the motion is not. See ArmSwivel above for where it
    # went and why, and below for the cube that was dropped outright.
    "立方体.004":    ("Arm",     "ArmCartridge"),
    "立方体.005":    ("Arm",     "ArmClip"),
    "柱体.017":      ("Arm",     "ArmTube"),
    "柱体.018":      ("Arm",     "ArmHeadshell"),
    "柱体.019":      ("Arm",     "ArmStylus"),
    "柱体.020":      ("Arm",     "ArmCwRing"),
    "柱体.021":      ("Arm",     "ArmCwBody"),
    "柱体.022":      ("Arm",     "ArmCwKnurl"),
    "柱体.023":      ("Arm",     "ArmCwEnd"),

    # --- the lid: three objects, and only three -----------------------------
    # 立方体.011 is the swing (its local X is the hinge axis), 立方体.009 is the
    # panel, 立方体.010 is the arm on the other side. The chain between them is the
    # whole lid, which is why it can be driven by one rotation on one node.
    "立方体.009":    ("Cover",   "CoverGlass"),
    "立方体.010":    ("Cover",   "CoverHingeR"),
    "立方体.011":    ("Cover",   "CoverHingeL"),

    # --- and the hinge it swings on, which is bolted to the deck -------------
    # The four barrels and caps are the deck's half of the hinge. They sit on the
    # same axis, so turning them with the lid is invisible in the render and was
    # easy to miss — but it is wrong. They are a mount, not part of the moving
    # panel.
    "柱体.024":      ("CoverMount", "HingeBarrelRCap"),
    "柱体.025":      ("CoverMount", "HingeBarrelLCap"),
    "柱体.026":      ("CoverMount", "HingeBarrelR"),
    "柱体.027":      ("CoverMount", "HingeBarrelL"),
}

MAT = {
    "材质": "BrandInk", "材质.001": "Copper", "材质.002": "Vinyl",
    "材质.003": "CoverAcrylic", "材质.004": "PlatterMatDark",
    "材质.005": "PlatterSteel", "材质.006": "PlinthDark",
    "材质.007": "KnobMetal", "材质.008": "KnobDark01", "材质.009": "KnobDark02",
    "材质.010": "KnobMetalLight", "材质.011": "HingeCap", "材质.012": "HingeDark",
    "材质.013": "Plinth", "材质.014": "ArmTrim", "材质.015": "ArmTube",
    "材质.016": "ArmDark", "材质.017": "ArmCounter", "材质.018": "ArmWeight",
    "材质.019": "ArmBase", "材质.020": "Brass", "材质.022": "RecordLabel",
    "材质.不锈钢": "Steel",
}

# ------------------------------------------------------------------ 2. pivots
DECK_TOP = 0.4896                      # 立方体's world top face, Blender Z
SCALE = 10.5 / 11.6804                 # plinth 11.68 -> 10.5 page units

# The lid's hinge line. NOT guessed, and not a number to be typed in: it is read
# off the node that actually carries the lid.
#
# `立方体.011` is the lid's swing — its local X *is* the hinge axis, and in world
# terms that axis comes out as exactly +X, which is what makes a hinge a line
# across the back rather than a pin at one corner. Its origin is a point on that
# line, and because rotating a node about its own axis does not move its origin,
# the line is the same whether the lid is open or shut in the file being read.
#
# This replaces a plausible-looking guess of (0, 5.30, DECK_TOP). The guess was
# 0.33 units below the real axis, and swinging the lid about an axis that low
# drops the whole panel by 0.54 units — 19 mm — when it shuts: the lid sinks
# into the plinth and the counterweight, which has 6 mm of clearance under the
# real closure, comes up through the glass.
LID_ARM = "立方体.011"
_arm = bpy.data.objects[LID_ARM]

# Open the lid here, before anything else has looked at it — and in particular
# before the re-parenting below, which is the part that matters.
#
# Zeroing this node's rotation is what "lid open" means in this file: it is the
# value the file ships with, and turning that one node about its own X is the
# lid's entire motion. It has to happen while the node still hangs off its own
# parent, because once it is re-parented onto the Cover empty its `rotation_euler`
# is measured against *that*, and writing zero there sets the basis rotation to
# identity relative to a parent whose inverse matrix was baked for a different
# relationship — which is not an open lid, it is an arbitrary pose. The first
# version of this did it in the wrong place and the export came out with 0.13° of
# lid travel while still looking correct in every report.
#
# Which pose the file happens to be saved in must not matter to the page.
_arm.rotation_euler = (0.0, 0.0, 0.0)
bpy.context.view_layer.update()

_axis = (_arm.matrix_world.to_3x3() @ Vector((1.0, 0.0, 0.0))).normalized()
if abs(_axis.x) < 0.999:
    raise SystemExit(f"{LID_ARM}: hinge axis is not along X, it is {tuple(round(v, 4) for v in _axis)}")
LID_Y = _arm.matrix_world.translation.y
LID_Z = _arm.matrix_world.translation.z

GROUPS = {
    "Plinth":  (0.0, 0.0, DECK_TOP),
    "Platter": (-0.917, 0.2538, DECK_TOP),    # the spindle's axis
    "Record":  (-0.917, 0.2538, DECK_TOP),
    "Arm":     (4.2750, 3.1000, DECK_TOP),    # the bearing's axis — the swing
    # ArmMount sits on the same axis but is never written to: this is the part
    # that is bolted down. The arm swings in it; it does not swing.
    "ArmMount": (4.2750, 3.1000, DECK_TOP),   # the tower, which does not move
    # The bearing assembly: same axis, yaw only — see the note on the OBJ map.
    "ArmSwivel": (4.2750, 3.1000, DECK_TOP),
    "Cover":   (0.0, LID_Y, LID_Z),           # the hinge line, measured above
    # The hinge barrels, on the same line, never written to: bolted to the deck.
    "CoverMount": (0.0, LID_Y, LID_Z),
}

rep = {"unassigned": []}

# ------------------------------------------------------------- 1b. omissions
# Meshes that are in the .blend and do not belong in the deck.
#
# `立方体.006` is a bracket the tonearm tube passes straight through. Not near,
# not swept past — through: the tube spans Y 2.87 to -2.61 at Z 1.09..1.42 and
# X 4.11..4.43, and the bracket occupies Y 2.04..2.25, Z 0.40..1.49, X 4.00..4.52,
# so the two intersect for the whole of the arm's travel and the long arm reads as
# sawing through a small U-shaped stand. Whatever it was modelled to hold, as
# authored it stands in the arm's path, and there is no group to put it in that
# fixes that — the page can move parts, it cannot make them not intersect. Asked
# for by name. Deleted here, in memory: the .blend is never written to.
DROP = ["立方体.006"]
for name in DROP:
    o = D.objects.get(name)
    if o:
        me = o.data
        D.objects.remove(o, do_unlink=True)
        if me and me.users == 0:
            D.meshes.remove(me)
rep["dropped"] = DROP

for o in D.objects:
    if o.type == 'MESH' and o.name not in OBJ:
        rep["unassigned"].append(o.name)
if rep["unassigned"]:
    raise SystemExit("unmapped meshes: " + repr(rep["unassigned"]))

for old, (grp, new) in OBJ.items():
    o = D.objects.get(old)
    if o:
        o.name = new
for old, new in MAT.items():
    m = D.materials.get(old)
    if m:
        m.name = new
rep["renamed_objects"] = len(OBJ)
rep["renamed_materials"] = len(MAT)

# ------------------------------------------------------------- 3. hierarchy
root = D.objects.new("Turntable", None)
sc.collection.objects.link(root)
empties = {}
for grp, loc in GROUPS.items():
    e = D.objects.new(grp, None)
    sc.collection.objects.link(e)
    e.parent = root
    e.location = loc
    empties[grp] = e
bpy.context.view_layer.update()

for old, (grp, new) in OBJ.items():
    o = D.objects.get(new)
    if not o:
        continue
    world = o.matrix_world.copy()          # capture BEFORE re-parenting
    o.parent = empties[grp]
    o.matrix_parent_inverse = empties[grp].matrix_world.inverted()
    o.matrix_world = world                 # ...and write it back AFTER
bpy.context.view_layer.update()

# --------------------------------------------------- 3b. shut the lid
# The file has the cover standing at about 78°, which makes the model a 10 x 10
# x 10 cube and leaves the page nothing to reveal. Exporting it shut instead
# gives a compact deck that frames like the tape did, and makes opening the lid
# something the page can *do* — on the intro, and again on 落针.
#
# The angle is measured off the glass slab's own normal (a lid is a flat panel;
# its normal is the one axis that tells you how far it has swung), and then the
# sign is chosen by trying both and keeping whichever actually closes it. The
# rotation is about the empty's local X, which is the hinge line.
import math
glass = D.objects.get("CoverGlass")
cover = empties["Cover"]

# The lid was opened up in the pivots step, before re-parenting, so what is
# measured here is the glass standing at its full swing — see the note there.
n = (glass.matrix_world.to_3x3() @ Vector((0.0, 0.0, 1.0))).normalized()
theta = math.atan2(abs(n.y), abs(n.z))


def height():
    bpy.context.view_layer.update()
    zs = [(o.matrix_world @ Vector(c)).z for o in D.objects if o.type == 'MESH' for c in o.bound_box]
    return max(zs) - min(zs)


best = None
for sign in (1.0, -1.0):
    cover.rotation_euler = (sign * theta, 0.0, 0.0)
    h = height()
    if best is None or h < best[1]:
        best = (sign, h)
cover.rotation_euler = (best[0] * theta, 0.0, 0.0)
bpy.context.view_layer.update()

# ------------------------------------------------- 3c. wind the cartridge out
# `立方体.004` (ArmCartridge) is inside out. Its polygons run the opposite way
# round from every other mesh in the file, and the definition of that is a
# negative signed volume: with a positive determinant and no mirroring anywhere
# in its chain, the only thing that can turn the volume negative is the winding.
#
# It shows. three decides which side of a triangle is the front one from the
# winding, so the faces it drew as "front" were the cartridge's *inside* — the far
# wall of the box painted over the near one, which is how it was reported. The
# lighting was wrong with it, because Blender derives a mesh's normals from its
# winding and those normals pointed inward too.
#
# Reversing the loops fixes both at once. One mesh in the file is affected and the
# check is generic rather than a hard-coded name, so a second one would be caught
# rather than shipped. This happens in memory: the .blend belongs to its owner and
# this script never writes to it.
import bmesh
WINDS = []
for o in D.objects:
    if o.type != 'MESH':
        continue
    bm = bmesh.new()
    bm.from_mesh(o.data)
    closed = all(len(e.link_faces) == 2 for e in bm.edges)
    if closed and bm.calc_volume(signed=True) < 0.0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        bm.to_mesh(o.data)
        o.data.update()
        WINDS.append(o.name)
    bm.free()
rep["winding_flipped"] = WINDS
rep["cover_open_deg"] = round(math.degrees(theta), 3)
rep["cover_sign"] = best[0]
rep["height_closed"] = round(best[1], 4)
rep["lid_normal"] = [round(v, 4) for v in n]

# ------------------------------------------------- 4. units and origin
root.scale = (SCALE, SCALE, SCALE)
root.location = (0.0, 0.0, -DECK_TOP * SCALE)
bpy.context.view_layer.update()

lo = Vector((1e18,) * 3)
hi = Vector((-1e18,) * 3)
for o in D.objects:
    if o.type != 'MESH':
        continue
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        for i in range(3):
            lo[i] = min(lo[i], w[i])
            hi[i] = max(hi[i], w[i])

rep["bbox_min"] = [round(v, 4) for v in lo]
rep["bbox_max"] = [round(v, 4) for v in hi]
rep["size"] = [round(hi[i] - lo[i], 4) for i in range(3)]
# the one number main.js needs: the deck (y = 0) down to the feet
rep["dim_hd"] = round(-lo[2], 4)
rep["scale"] = round(SCALE, 6)
rep["group_children"] = {g: len(e.children) for g, e in empties.items()}
pl = D.objects.get("PlinthBody")
rep["plinth_dims"] = [round(v, 4) for v in pl.dimensions] if pl else None

# --- the two things a wrong hinge line breaks, checked where they are made ---
# Both of these were symptoms before the axis was measured: the panel sank into
# the plinth, and the counterweight came up through the glass. They are reported
# in millimetres because that is the scale at which they are visible.
LID = {"CoverGlass", "CoverHingeL", "CoverHingeR"}
lid_lo, lid_hi = 1e18, -1e18
oth_hi, oth_name = -1e18, None
for o in D.objects:
    if o.type != 'MESH':
        continue
    zs = [(o.matrix_world @ Vector(c)).z for c in o.bound_box]
    if o.name in LID:
        lid_lo = min(lid_lo, min(zs))
        lid_hi = max(lid_hi, max(zs))
    elif max(zs) > oth_hi:
        oth_hi, oth_name = max(zs), o.name
# world z is already in page units here — root.scale and root.location have been
# applied, the deck top is 0 and the plinth is 10.5 across for 420 mm, so one
# unit is 40 mm and there is no second scale factor to apply
rep["lid_underside_mm"] = round(lid_lo * 40, 2)
rep["lid_top_mm"] = round(lid_hi * 40, 2)
rep["tallest_other"] = {"name": oth_name, "top_mm": round(oth_hi * 40, 2)}
rep["clearance_mm"] = round((lid_hi - oth_hi) * 40, 2)

# ------------------------------------------------------------------ 5. export
OUT = r"D:\AAA Other\网页\turntable\assets\turntable.glb"
os.makedirs(os.path.dirname(OUT), exist_ok=True)
kwargs = dict(
    filepath=OUT, export_format='GLB',
    export_apply=True,             # bake Smooth-by-Angle into real normals
    export_yup=True,               # Blender Z-up -> glTF Y-up, which is three's
    export_normals=True, export_tangents=False,
    # uvs are kept: the record's grooves and its paper label are both maps, and
    # the cap of the cylinder Blender made for it already carries a planar
    # circular unwrap, which is exactly what those two want
    export_texcoords=True,
    export_materials='EXPORT',
    export_cameras=False, export_lights=False, export_animations=False,
    export_skins=False, use_selection=False,
)
try:
    bpy.ops.export_scene.gltf(**kwargs)
except TypeError as exc:
    rep["export_note"] = f"retried without optional args: {exc}"
    for k in ("export_morph", "export_skins", "export_tangents", "export_texcoords",
              "export_lights", "export_cameras", "export_animations"):
        kwargs.pop(k, None)
    bpy.ops.export_scene.gltf(**kwargs)

rep["glb"] = OUT
rep["glb_bytes"] = os.path.getsize(OUT) if os.path.exists(OUT) else None
print(json.dumps(rep, ensure_ascii=False, indent=1))

# Blender (headless) step for a rigged figure: puts it into a calm standing rest pose before it walks.
#
#   blender -b --factory-startup --python relax.py -- in.glb out.glb [report.json]
#
# TRELLIS rebuilds the figure in whatever pose Muse painted: arms often held up and out (a Y-pose), feet
# wide apart. The auto-rig skins it in that pose, and the game then swings arms ~100 degrees down and walks
# legs that are planted wide, so every frame shows the skinning's worst case: shoulders pinched, sleeves
# glued to the chest, hands sticking out, a waddle. Here Blender poses arms down and feet under the hips
# once, smooths the deformed shoulders and hips with a Corrective Smooth, and makes that the new rest pose.
# The game's own walk then turns bones only a little from rest. The original positions travel along as the
# _REST vertex attribute, so paintings projected in the original pose still land on the same surface.
import bpy, sys, json, math
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]
report_path = argv[2] if len(argv) > 2 else None
report = {'ok': False}


def bind_pose_glb(path, out):
    """The glb with every joint node moved to its bind pose (mesh world x inverse bind matrix).

    Make-It-Animatable saves its bones in its own T-pose (seated, leant back for a long coat) while the mesh
    is in the pose TRELLIS built; three.js and the game bind with the inverse bind matrices, Blender takes
    the nodes as rest. Moving the nodes makes both agree (the same as web/hero3d.ts toBindPose)."""
    import struct, numpy as np
    data = open(path, 'rb').read()
    n = struct.unpack_from('<I', data, 12)[0]
    gj = json.loads(data[20:20 + n])
    rest = data[20 + n:]
    blen = struct.unpack_from('<I', rest, 0)[0]
    blob = rest[8:8 + blen]
    nodes = gj['nodes']

    def local(nd):
        if 'matrix' in nd:
            return np.array(nd['matrix'], dtype=float).reshape(4, 4).T
        T = np.eye(4); T[:3, 3] = nd.get('translation', [0, 0, 0])
        x, y, z, w = nd.get('rotation', [0, 0, 0, 1])
        R = np.eye(4)
        R[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        S = np.diag(list(nd.get('scale', [1, 1, 1])) + [1])
        return T @ R @ S
    parent = {c: i for i, nd in enumerate(nodes) for c in nd.get('children', [])}

    def world(i):
        M = local(nodes[i])
        while i in parent:
            i = parent[i]
            M = local(nodes[i]) @ M
        return M
    mesh_node = next(i for i, nd in enumerate(nodes) if 'skin' in nd)
    skin = gj['skins'][nodes[mesh_node]['skin']]
    acc = gj['accessors'][skin['inverseBindMatrices']]
    bv = gj['bufferViews'][acc['bufferView']]
    off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    ibm = np.frombuffer(blob[off:off + 64 * acc['count']], dtype='<f4').reshape(-1, 4, 4).transpose(0, 2, 1)
    MW = world(mesh_node)
    joints = skin['joints']
    depth = lambda i: 0 if i not in parent else 1 + depth(parent[i])
    for k in sorted(range(len(joints)), key=lambda k: depth(joints[k])):
        j = joints[k]
        bind = MW @ np.linalg.inv(ibm[k].astype(float))
        pw = world(parent[j]) if j in parent else np.eye(4)
        L = np.linalg.inv(pw) @ bind
        for key in ('translation', 'rotation', 'scale'):
            nodes[j].pop(key, None)
        nodes[j]['matrix'] = [float(v) for v in L.T.reshape(-1)]
    js = json.dumps(gj).encode()
    js += b' ' * (-len(js) % 4)
    body = struct.pack('<II', len(js), 0x4E4F534A) + js + rest
    open(out, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


import os, tempfile
bound = os.path.join(tempfile.mkdtemp(), 'bind.glb')
bind_pose_glb(src, bound)
bpy.ops.wm.read_factory_settings(use_empty=True)
# Seams merged: Corrective Smooth would otherwise smooth each UV island apart and open cracks.
bpy.ops.import_scene.gltf(filepath=bound, merge_vertices=True)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)]
if not meshes:
    raise SystemExit('no skinned mesh')
mesh = max(meshes, key=lambda o: len(o.data.vertices))
if mesh.data.shape_keys:
    raise SystemExit('the mesh has shape keys (facial morphs): its pose is left as it is')
# Some rigs turn the mesh node itself (Make-It-Animatable leans it ~30 degrees); glTF ignores a skinned
# mesh's own node, and three.js binds with it, so it is baked into the vertices first.
# The same for the nodes above the armature: every object ends at identity, so the exported inverse bind
# matrices and the mesh agree whatever the reader does with node transforms.
def flatten(o):
    for x in bpy.context.selected_objects:
        x.select_set(False)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
flatten(mesh)
flatten(arm)
for o in list(bpy.data.objects):
    if o.type == 'EMPTY':
        bpy.data.objects.remove(o)
mesh.parent = arm
pb = {b.name.split(':')[-1]: b for b in arm.pose.bones}
need = ['Hips', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftFoot', 'RightUpLeg', 'RightFoot']
missing = [n for n in need if n not in pb]
if missing:
    raise SystemExit('bones missing: ' + ', '.join(missing))

bpy.context.view_layer.objects.active = arm
for b in arm.pose.bones:
    b.rotation_mode = 'QUATERNION'
    b.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
W = arm.matrix_world

def head(n):
    return W @ pb[n].head

def rotate_world(n, R):
    """Turn bone n (and so its children) by world rotation R about its head."""
    b = pb[n]
    h = head(n)
    world = W @ b.matrix
    world = Matrix.Translation(h) @ R.to_matrix().to_4x4() @ Matrix.Translation(-h) @ world
    b.matrix = W.inverted() @ world
    bpy.context.view_layer.update()

# Which way is up, and which way the figure faces, in Blender's world (glTF +y up, +z facing -> Blender +z, -y).
up = Vector((0, 0, 1))
height = max((mesh.matrix_world @ v.co).z for v in mesh.data.vertices) - min((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)
report['height'] = height

# Arms: shoulder -> wrist straight down and a little out, in the figure's own frontal plane.
ARM_OUT = math.radians(5)
arms = {}
for side, s in (('Left', 1), ('Right', -1)):
    a, w = head(f'{side}Arm'), head(f'{side}Hand')
    cur = (w - a).normalized()
    out = Vector((s, 0, 0))
    want = (out * math.sin(ARM_OUT) - up * math.cos(ARM_OUT)).normalized()
    arms[side] = math.degrees(cur.angle(want))
    rotate_world(f'{side}Arm', cur.rotation_difference(want))
    # Elbow: forearm in line with the upper arm, a slight natural bend forward.
    e, w = head(f'{side}ForeArm'), head(f'{side}Hand')
    cur = (w - e).normalized()
    upper = (e - head(f'{side}Arm')).normalized()
    bend = Matrix.Rotation(math.radians(8), 3, Vector((1, 0, 0)))
    want = (bend @ upper).normalized()
    if want.y > upper.y:  # bend toward the front (-y), never backwards
        want = (bend.inverted() @ upper).normalized()
    rotate_world(f'{side}ForeArm', cur.rotation_difference(want))
    # Hand in line with the forearm (a held-up palm otherwise sticks out sideways).
    hb = pb[f'{side}Hand']
    tail = W @ hb.tail
    cur = (tail - head(f'{side}Hand')).normalized()
    fore = (head(f'{side}Hand') - head(f'{side}ForeArm')).normalized()
    rotate_world(f'{side}Hand', cur.rotation_difference(fore))
report['armTurn'] = arms

# Palms toward the thighs. A raised hand is painted palm forward or down; turned down with the arm it faces
# back or out, and the fingers splay away from the body like a zombie's. The palm's normal is the hand's
# flattest direction (least spread of its vertices, posed); the hand turns about the forearm until it points
# across the body.
def posed_points(group_name):
    g = mesh.vertex_groups.get(group_name)
    if g is None:
        return []
    dg = bpy.context.evaluated_depsgraph_get()
    ev = mesh.evaluated_get(dg).data
    pts = []
    for v in mesh.data.vertices:
        for vg in v.groups:
            if vg.group == g.index and vg.weight > 0.6:
                pts.append(mesh.matrix_world @ ev.vertices[v.index].co)
    return pts

palms = {}
for side, s in (('Left', 1), ('Right', -1)):
    name = pb[f'{side}Hand'].name
    pts = posed_points(name)
    if len(pts) < 12:
        continue
    import numpy as np
    P = np.array([tuple(p) for p in pts])
    P -= P.mean(axis=0)
    _, _, vt = np.linalg.svd(P, full_matrices=False)
    normal = Vector(vt[2].tolist())
    axis = (head(f'{side}Hand') - head(f'{side}ForeArm')).normalized()
    n = (normal - axis * normal.dot(axis))
    want = Vector((1, 0, 0)) - axis * axis.x
    if n.length < 1e-6 or want.length < 1e-6:
        continue
    n.normalize(); want.normalize()
    if n.dot(want) < 0:
        n = -n  # a plane's normal has no sign: the smaller turn
    angle = math.atan2(n.cross(want).dot(axis), n.dot(want))
    palms[side] = math.degrees(angle)
    if abs(angle) > math.radians(10):
        rotate_world(f'{side}Hand', Matrix.Rotation(angle, 3, axis).to_quaternion())
report['palmTurn'] = palms

# Legs: ankle under the hip joint, turned only in the frontal plane; feet keep their world orientation (flat).
legs = {}
for side, s in (('Left', 1), ('Right', -1)):
    foot_world = (W @ pb[f'{side}Foot'].matrix).to_quaternion()
    h, f = head(f'{side}UpLeg'), head(f'{side}Foot')
    cur = f - h
    # Only the sideways part changes (ankle a quarter of the hip joint's offset out): same forward lean.
    want = Vector(((h.x - head('Hips').x) * 0.25, cur.y, cur.z))
    legs[side] = math.degrees(cur.angle(want))
    if legs[side] < 25:  # more is a kick or a stride, not a stance
        rotate_world(f'{side}UpLeg', cur.normalized().rotation_difference(want.normalized()))
    now = (W @ pb[f'{side}Foot'].matrix).to_quaternion()
    rotate_world(f'{side}Foot', foot_world @ now.inverted())
report['legTurn'] = legs

# Bake the pose into the mesh, smoothing what skinning pinched, then make it the rest pose.
bpy.ops.object.mode_set(mode='OBJECT')
orig = [v.co.copy() for v in mesh.data.vertices]
armmod = next(m for m in mesh.modifiers if m.type == 'ARMATURE')
cs = mesh.modifiers.new('relax', 'CORRECTIVE_SMOOTH')
cs.rest_source = 'ORCO'
cs.smooth_type = 'LENGTH_WEIGHTED'
cs.iterations = 8
cs.factor = 0.5
cs.use_only_smooth = False
bpy.context.view_layer.objects.active = mesh
dg = bpy.context.evaluated_depsgraph_get()
ev = mesh.evaluated_get(dg)
baked = [v.co.copy() for v in ev.data.vertices]
if len(baked) != len(orig):
    raise SystemExit('modifier changed vertex count')
mesh.modifiers.remove(cs)
for v, p in zip(mesh.data.vertices, baked):
    v.co = p
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode='OBJECT')

# The original surface, in glTF's axes (x, z, -y) and the mesh's own space, for projecting the paintings.
attr = mesh.data.attributes.new('_REST', 'FLOAT_VECTOR', 'POINT')
for i, p in enumerate(orig):
    attr.data[i].vector = (p.x, p.z, -p.y)

# Stray pieces (the 42-vertex marker sphere some rigs carry) stay out of the export.
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o is not mesh:
        bpy.data.objects.remove(o)

move = max((a - b).length for a, b in zip(baked, orig)) / height
report['maxMove'] = move
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_attributes=True, export_skins=True,
                          export_animations=False, export_yup=True, export_apply=False)
report['ok'] = True
if report_path:
    with open(report_path, 'w') as f:
        json.dump(report, f)
print('RELAX', json.dumps(report))

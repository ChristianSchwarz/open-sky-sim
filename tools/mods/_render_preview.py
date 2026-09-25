import sys
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
blend_path, out_png = argv[0], argv[1]

bpy.ops.wm.open_mainfile(filepath=blend_path)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
mins = Vector((min(o.matrix_world.translation.x for o in meshes), 0, 0))
bbox_min = Vector((1e9, 1e9, 1e9))
bbox_max = Vector((-1e9, -1e9, -1e9))
for o in meshes:
    for corner in o.bound_box:
        wc = o.matrix_world @ Vector(corner)
        bbox_min = Vector(min(a, b) for a, b in zip(bbox_min, wc))
        bbox_max = Vector(max(a, b) for a, b in zip(bbox_max, wc))
center = (bbox_min + bbox_max) / 2
size = (bbox_max - bbox_min).length

cam_data = bpy.data.cameras.new('Cam')
cam = bpy.data.objects.new('Cam', cam_data)
bpy.context.scene.collection.objects.link(cam)
cam.location = center + Vector((size * 0.9, -size * 0.9, size * 0.6))
direction = center - cam.location
cam.rotation_mode = 'QUATERNION'
cam.rotation_quaternion = direction.to_track_quat('-Z', 'Y')
bpy.context.scene.camera = cam

sun_data = bpy.data.lights.new('Sun', 'SUN')
sun_data.energy = 3.0
sun = bpy.data.objects.new('Sun', sun_data)
sun.rotation_euler = (0.8, 0.3, 0.6)
bpy.context.scene.collection.objects.link(sun)

scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.light = 'STUDIO'
scene.render.resolution_x = 1280
scene.render.resolution_y = 800
scene.render.filepath = out_png
bpy.ops.render.render(write_still=True)
print(f'Rendered {out_png}')

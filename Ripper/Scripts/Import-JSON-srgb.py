bl_info = {
    "name": "JSON Color Timeline Importer (RGBA, No Principled)",
    "author": "You + GPT",
    "version": (1, 3, 0),
    "blender": (3, 0, 0),
    "location": "File > Import > JSON Color Timeline (.json)",
    "description": "Imports color keyframes from a JSON timeline using designer-friendly RGBA schema; keeps existing shader graph intact.",
    "category": "Import-Export",
}

import bpy
import json
from bpy.types import Operator
from bpy.props import (
    StringProperty,
    BoolProperty,
    EnumProperty,
)
from bpy_extras.io_utils import ImportHelper

# --------------------------------------------------------------------------
# Color helpers
# --------------------------------------------------------------------------

def hex_to_srgb_tuple(hex_color: str):
    h = hex_color.strip()
    if h.startswith("#"):
        h = h[1:]
    if len(h) != 6:
        raise ValueError(f"Bad hex color: {hex_color}")
    r = int(h[0:2], 16) / 255.0
    g = int(h[2:4], 16) / 255.0
    b = int(h[4:6], 16) / 255.0
    return (r, g, b)

def srgb_to_linear_channel(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def srgb_to_linear(rgb):
    return tuple(srgb_to_linear_channel(c) for c in rgb)

def hex_to_linear_rgba(hex_color: str):
    rgb = hex_to_srgb_tuple(hex_color)
    rgb_lin = srgb_to_linear(rgb)
    return (rgb_lin[0], rgb_lin[1], rgb_lin[2], 1.0)

def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)

def parse_rgba_value(value):
    # Accepts:
    #  - '#RRGGBB' legacy (sRGB, alpha=1.0)
    #  - {'rgba':[r,g,b,a], 'space':'srgb'|'linear'} with 0..1 floats
    # Returns (rgba_linear, css_alpha)
    if isinstance(value, str) and value.startswith('#'):
        rgba = hex_to_linear_rgba(value)
        return rgba, 1.0

    if isinstance(value, dict) and 'rgba' in value:
        r, g, b, a = value['rgba']
        space = value.get('space', 'srgb').lower()

        r = clamp01(float(r)); g = clamp01(float(g)); b = clamp01(float(b)); a = clamp01(float(a))

        if space == 'linear':
            r_lin, g_lin, b_lin = r, g, b
        else:
            r_lin = srgb_to_linear_channel(r)
            g_lin = srgb_to_linear_channel(g)
            b_lin = srgb_to_linear_channel(b)

        return (r_lin, g_lin, b_lin, 1.0), a

    raise ValueError('Unsupported color value format.')

# --------------------------------------------------------------------------
# Node/material helpers (NO Principled BSDF creation)
# --------------------------------------------------------------------------

def ensure_unique_material(obj, make_if_missing=True):
    # Ensure the object has its own material slot and unique material
    if obj.type not in {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT'}:
        return None

    # Ensure slot + material
    if len(obj.data.materials) == 0 or obj.data.materials[0] is None:
        if not make_if_missing:
            return None
        mat = bpy.data.materials.new(name=f"AutoColor_{obj.name}")
        mat.use_nodes = True
        if len(obj.data.materials) == 0:
            obj.data.materials.append(mat)
        else:
            obj.data.materials[0] = mat
        return mat

    mat = obj.data.materials[0]
    if mat.users > 1:
        mat = mat.copy()
        obj.data.materials[0] = mat

    if not mat.use_nodes:
        mat.use_nodes = True
    return mat

def get_or_create_rgb_node(nt):
    # Return existing ShaderNodeRGB if found; otherwise create one. Do not alter links.
    rgb = next((n for n in nt.nodes if n.bl_idname == 'ShaderNodeRGB'), None)
    if rgb is None:
        rgb = nt.nodes.new('ShaderNodeRGB')
        rgb.label = 'RGB'
        rgb.location = (-400, 0)
    return rgb

def find_mix_with_transparent(nt):
    # Find a Mix Shader node that mixes with a Transparent BSDF.
    transparent_nodes = {n for n in nt.nodes if n.bl_idname == 'ShaderNodeBsdfTransparent'}
    if not transparent_nodes:
        return None

    candidates = []
    for n in nt.nodes:
        if n.bl_idname != 'ShaderNodeMixShader':
            continue
        for idx in (1, 2):
            link = n.inputs[idx].links[0] if n.inputs[idx].links else None
            if link and link.from_node in transparent_nodes:
                candidates.append(n)
                break

    if not candidates:
        return None

    # Prefer the one closest to Material Output
    outputs = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeOutputMaterial']
    if outputs:
        from collections import deque, defaultdict
        dist = defaultdict(lambda: 1e9)
        q = deque()
        for out in outputs:
            dist[out] = 0
            q.append(out)
        while q:
            cur = q.popleft()
            d = dist[cur]
            for inp in getattr(cur, 'inputs', []):
                for l in inp.links:
                    prev = l.from_node
                    if dist[prev] > d + 1:
                        dist[prev] = d + 1
                        q.append(prev)
        candidates.sort(key=lambda n: dist[n])
    return candidates[0]

def clear_existing_rgb_keys(nt, rgb_node_name):
    # Remove existing fcurves targeting that RGB node output default_value.
    if not nt:
        return
    ad = nt.animation_data
    if not ad or not ad.action:
        return
    base_path = f'nodes["{rgb_node_name}"].outputs[0].default_value'
    action = ad.action
    removed_any = False
    for fc in list(action.fcurves):
        if fc.data_path == base_path:
            action.fcurves.remove(fc)
            removed_any = True
    if removed_any and len(action.fcurves) == 0:
        nt.animation_data.action = None

def clear_existing_mix_fac_keys(nt, mix_node_name):
    if not nt:
        return
    ad = nt.animation_data
    if not ad or not ad.action:
        return
    base_path = f'nodes["{mix_node_name}"].inputs[0].default_value'
    action = ad.action
    for fc in list(action.fcurves):
        if fc.data_path == base_path:
            action.fcurves.remove(fc)
    if ad.action and len(ad.action.fcurves) == 0:
        nt.animation_data.action = None

def insert_rgba_key_on_rgb_output(nt, rgb_node_name, frame, rgba, interpolation='BEZIER'):
    base_path = f'nodes["{rgb_node_name}"].outputs[0].default_value'
    try:
        sock = nt.path_resolve(base_path)
        sock[0], sock[1], sock[2], sock[3] = rgba
    except Exception:
        try:
            nt.nodes[rgb_node_name].outputs[0].default_value = rgba
        except Exception:
            return
    for i in range(4):
        nt.keyframe_insert(data_path=base_path, index=i, frame=frame)

    ad = nt.animation_data
    if ad and ad.action:
        for fc in ad.action.fcurves:
            if fc.data_path == base_path:
                for kp in fc.keyframe_points:
                    kp.interpolation = interpolation

def insert_mix_fac_key(nt, mix_node_name, frame, fac_value, interpolation='BEZIER'):
    base_path = f'nodes["{mix_node_name}"].inputs[0].default_value'
    try:
        nt.nodes[mix_node_name].inputs[0].default_value = float(fac_value)
    except Exception:
        return
    nt.keyframe_insert(data_path=base_path, frame=frame)

    ad = nt.animation_data
    if ad and ad.action:
        for fc in ad.action.fcurves:
            if fc.data_path == base_path:
                for kp in fc.keyframe_points:
                    kp.interpolation = interpolation

# --------------------------------------------------------------------------
# Import operator
# --------------------------------------------------------------------------

class IMPORT_SCENE_json_color_timeline_no_principled(Operator, ImportHelper):
    bl_idname = "import_scene.json_color_timeline_no_principled"
    bl_label = "JSON Color Timeline (.json) — Keep Shader Graph (RGBA)"
    bl_options = {'UNDO'}

    filename_ext = ".json"
    filter_glob: StringProperty(default="*.json", options={'HIDDEN'})

    selected_only: BoolProperty(
        name="Only Selected Objects",
        description="Limit to selected objects (by name match with JSON 'set' keys)",
        default=False,
    )
    make_materials_unique: BoolProperty(
        name="Make Materials Unique Per Object",
        description="Copy shared materials so each object can be keyed independently",
        default=True,
    )
    clear_existing_keys: BoolProperty(
        name="Clear Existing Keys",
        description="Remove prior keys on the RGB color and Mix Fac before importing",
        default=True,
    )
    interpolation: EnumProperty(
        name="Interpolation",
        description="Interpolation for inserted keyframes",
        items=[
            ('CONSTANT', "Constant", ""),
            ('LINEAR', "Linear", ""),
            ('BEZIER', "Bezier", ""),
        ],
        default='CONSTANT',
    )
    key_viewport_diffuse: BoolProperty(
        name="Also Keyframe Material Diffuse (viewport)",
        description="Keyframe material.diffuse_color alongside node color for better viewport feedback",
        default=False,
    )

    def execute(self, context):
        # Load JSON
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            self.report({'ERROR'}, f"Failed to read JSON: {e}")
            return {'CANCELLED'}

        # Validate
        if not isinstance(data, dict) or "fps" not in data or "events" not in data:
            self.report({'ERROR'}, "JSON must contain 'fps' (number) and 'events' (list).")
            return {'CANCELLED'}

        try:
            fps = int(data["fps"])
        except Exception:
            self.report({'ERROR'}, f"Invalid fps: {data.get('fps')}")
            return {'CANCELLED'}

        events = data["events"]
        if not isinstance(events, list) or len(events) == 0:
            self.report({'ERROR'}, "'events' must be a non-empty list.")
            return {'CANCELLED'}

        # Collect target names from JSON
        target_names = set()
        for ev in events:
            s = ev.get("set", {})
            if isinstance(s, dict):
                target_names.update(s.keys())

        # Build object map
        if self.selected_only:
            candidates = {o.name: o for o in context.selected_objects}
            obj_map = {name: obj for name, obj in candidates.items() if name in target_names}
        else:
            obj_map = {o.name: o for o in bpy.data.objects if o.name in target_names}

        if not obj_map:
            self.report({'WARNING'}, "No matching objects found for JSON 'set' keys.")

        # Prepare per-object: ensure material, find/create RGB node, clear keys if requested
        prep = {}
        for name, obj in obj_map.items():
            mat = ensure_unique_material(obj, make_if_missing=True)
            if mat and self.make_materials_unique and mat.users > 1:
                mat = mat.copy()
                obj.data.materials[0] = mat

            if not mat or not mat.node_tree:
                continue

            nt = mat.node_tree
            rgb = get_or_create_rgb_node(nt)
            mix = find_mix_with_transparent(nt)

            if self.clear_existing_keys:
                clear_existing_rgb_keys(nt, rgb.name)
                if mix:
                    clear_existing_mix_fac_keys(nt, mix.name)

            prep[name] = (mat, nt, rgb.name, mix.name if mix else None)

        # Convert times to frames & import keys
        frame_events = []
        min_frame, max_frame = None, None

        for ev in events:
            try:
                t = float(ev.get("t", 0.0))
            except Exception:
                t = 0.0
            frame = int(round(t * fps))
            frame_events.append((frame, ev.get("set", {}) if isinstance(ev.get("set", {}), dict) else {}))
            min_frame = frame if min_frame is None else min(min_frame, frame)
            max_frame = frame if max_frame is None else max(max_frame, frame)

        scene = context.scene

        # Insert keys
        for frame, mapping in frame_events:
            scene.frame_set(frame)
            for obj_name, val in mapping.items():
                triple = prep.get(obj_name)
                if triple is None:
                    continue

                mat, nt, rgb_name, mix_name = triple

                # Parse RGBA
                try:
                    rgba_linear, a_css = parse_rgba_value(val)
                except Exception:
                    # Fallback to legacy hex route if provided
                    try:
                        rgba_linear = hex_to_linear_rgba(val)
                        a_css = 1.0
                    except Exception:
                        continue

                insert_rgba_key_on_rgb_output(nt, rgb_name, frame, rgba_linear, interpolation=self.interpolation)

                # Mix Fac = 1 - alpha
                if mix_name:
                    fac = 1.0 - a_css
                    insert_mix_fac_key(nt, mix_name, frame, fac, interpolation=self.interpolation)

                if self.key_viewport_diffuse:
                    try:
                        mat.diffuse_color = (*rgba_linear[:3], 1.0)
                        mat.keyframe_insert(data_path="diffuse_color", frame=frame)
                        ad = mat.animation_data
                        if ad and ad.action:
                            for fc in ad.action.fcurves:
                                if fc.data_path == "diffuse_color":
                                    for kp in fc.keyframe_points:
                                        kp.interpolation = self.interpolation
                    except Exception:
                        pass

        # Set scene FPS and frame range
        if min_frame is None:
            min_frame = 0
        if max_frame is None:
            max_frame = min_frame

        scene.render.fps = fps
        scene.frame_start = min_frame
        scene.frame_end = max_frame

        self.report({'INFO'}, f"Imported {len(frame_events)} events | FPS {fps} | Frames {scene.frame_start}-{scene.frame_end}")
        return {'FINISHED'}

# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------

def menu_func_import(self, context):
    self.layout.operator(IMPORT_SCENE_json_color_timeline_no_principled.bl_idname,
                         text="JSON Color Timeline (.json) — Keep Shader Graph (RGBA)")

classes = (IMPORT_SCENE_json_color_timeline_no_principled,)

def register():
    for c in classes:
        bpy.utils.register_class(c)
    bpy.types.TOPBAR_MT_file_import.append(menu_func_import)

def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_func_import)
    for c in reversed(classes):
        bpy.utils.unregister_class(c)

if __name__ == "__main__":
    register()

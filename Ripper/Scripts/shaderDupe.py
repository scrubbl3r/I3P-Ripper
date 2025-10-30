import bpy

# ===== CONFIG =====
SOURCE_MAT_NAME = "MS"       # source shader/material to duplicate
ENUM_PREFIX = "MS"           # base name for enumerated copies: MS_1, MS_2, ...
START_INDEX = 1              # start counting at 1
REPLACE_ALL_SLOTS = True     # True: replace all slots; False: only first slot
# Target name ranges (applied in this exact order)
TARGET_RANGES = [
    ("D", 294),
    ("L", 942),
    ("T", 613),
]
# ===================

def get_source_material(name: str):
    mat = bpy.data.materials.get(name)
    if mat is None:
        raise ValueError(f'Source material "{name}" not found.')
    return mat

def assign_material(obj, mat, replace_all=True):
    if obj.type != 'MESH':
        return False
    if not obj.data.materials:
        obj.data.materials.append(mat)
        return True
    if replace_all:
        for i in range(len(obj.data.materials)):
            obj.data.materials[i] = mat
    else:
        obj.data.materials[0] = mat
    return True

def iter_targets(ranges):
    for prefix, maxnum in ranges:
        for i in range(1, maxnum + 1):
            yield f"{prefix}{i}"

src = get_source_material(SOURCE_MAT_NAME)

index = START_INDEX
created_count = 0
applied_count = 0
skipped_nonmesh = []
missing = []

for name in iter_targets(TARGET_RANGES):
    obj = bpy.data.objects.get(name)
    if obj is None:
        missing.append(name)
        continue
    if obj.type != 'MESH':
        skipped_nonmesh.append(name)
        continue

    # Name for this object's unique material
    mat_name = f"{ENUM_PREFIX}_{index}"

    # Reuse if it already exists from a prior run; otherwise duplicate
    mat = bpy.data.materials.get(mat_name)
    if mat is None:
        mat = src.copy()
        mat.name = mat_name
        created_count += 1

    if assign_material(obj, mat, replace_all=REPLACE_ALL_SLOTS):
        applied_count += 1
        index += 1  # advance only when we successfully applied to a mesh

print("---- SUMMARY ----")
print(f'Source material: "{SOURCE_MAT_NAME}"')
print(f'Enumeration prefix: "{ENUM_PREFIX}"')
print(f"Started at index: {START_INDEX}")
print(f"Created new materials: {created_count}")
print(f"Objects updated: {applied_count}")
print(f"Last index used: {index - 1}")
if skipped_nonmesh:
    print(f"Skipped (non-mesh) [{len(skipped_nonmesh)}]: {', '.join(skipped_nonmesh[:15])}{' ...' if len(skipped_nonmesh) > 15 else ''}")
if missing:
    print(f"Missing objects [{len(missing)}]: {', '.join(missing[:15])}{' ...' if len(missing) > 15 else ''}")

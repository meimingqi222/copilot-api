#!/usr/bin/env python3
"""Fast scan of devin.exe .text for RIP-relative references to interesting strings."""

import sys
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64
from capstone.x86_const import X86_REG_RIP

PE_PATH = r"D:\code\copilot-refs\devin\devin.exe"

TARGETS = [
    (b"/exa.api_server_pb.ApiServerService/AssignModel", "endpoint"),
    (b"AssignModel returned empty assignment", "empty_msg"),
    (b"Resolving model router '", "resolve_log"),
    (b"Model router '", "resolved_log"),
    (b"ModelAssignmentmodel_uidassignment_jwtharness_uidsAssignModelResponseassignment", "debug_names"),
    (b"assignment_jwt", "field_jwt"),
    (b"harness_uids", "field_harness"),
    (b"model_uid", "field_model"),
    (b"model_router", "field_router"),
]

def main() -> None:
    pe = pefile.PE(PE_PATH)
    image_base = pe.OPTIONAL_HEADER.ImageBase

    with open(PE_PATH, "rb") as f:
        data = f.read()

    sections = []
    for sec in pe.sections:
        name = sec.Name.rstrip(b"\x00").decode("latin-1", errors="ignore")
        sections.append({
            "name": name,
            "file_offset": sec.PointerToRawData,
            "vaddr": sec.VirtualAddress + image_base,
            "vsize": sec.Misc_VirtualSize,
            "raw_size": sec.SizeOfRawData,
        })

    def file_offset_to_rva(off: int) -> int | None:
        for sec in sections:
            if sec["file_offset"] <= off < sec["file_offset"] + sec["raw_size"]:
                return sec["vaddr"] + (off - sec["file_offset"])
        return None

    text_sec = next((s for s in sections if s["name"] == ".text"), None)
    if text_sec is None:
        print("No .text section", file=sys.stderr)
        return

    text_data = data[text_sec["file_offset"]:text_sec["file_offset"]+text_sec["raw_size"]]
    text_rva_start = text_sec["vaddr"]

    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = True

    print("Scanning .text for RIP-relative references ...", file=sys.stderr)
    ref_map: dict[int, list[int]] = {}
    count = 0
    for insn in md.disasm(text_data, text_rva_start):
        count += 1
        if not insn.operands:
            continue
        for op in insn.operands:
            if op.type == 3:  # MEMORY
                if op.mem.base == X86_REG_RIP:
                    target = insn.address + insn.size + op.mem.disp
                    ref_map.setdefault(target, []).append(insn.address)
    print(f"Disassembled {count} instructions, found {len(ref_map)} unique RIP-relative targets", file=sys.stderr)

    md2 = Cs(CS_ARCH_X86, CS_MODE_64)
    md2.detail = True

    for target_bytes, label in TARGETS:
        print(f"\n=== TARGET: {label} {target_bytes!r} ===")
        off = data.find(target_bytes)
        if off == -1:
            print("  NOT FOUND")
            continue
        rva = file_offset_to_rva(off)
        if rva is None:
            print(f"  file off {off}: not in mapped section")
            continue
        print(f"  file off {off} -> RVA 0x{rva:08x}")

        refs = ref_map.get(rva, [])
        print(f"  {len(refs)} reference(s): {[hex(a) for a in refs[:10]]}")

        for ref_rva in refs[:5]:
            start = max(0, ref_rva - text_rva_start - 96)
            end = min(len(text_data), ref_rva - text_rva_start + 192)
            chunk = text_data[start:end]
            print(f"\n  Disassembly around 0x{ref_rva:08x}:")
            for insn in md2.disasm(chunk, text_rva_start + start):
                marker = "  <-- REF" if insn.address == ref_rva else ""
                print(f"    0x{insn.address:08x}: {insn.mnemonic:10s} {insn.op_str:s}{marker}")

if __name__ == "__main__":
    main()

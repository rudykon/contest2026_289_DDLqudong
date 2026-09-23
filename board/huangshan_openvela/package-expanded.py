"""Publish the hash-pinned, hardware-verified expanded EPIC candidate."""
from pathlib import Path
import hashlib
import json
import shutil

root = Path(__file__).resolve().parent
source = Path('D:/wsl_ubuntu/setup/velamotion-epic-expanded.bin')
sha = hashlib.sha256(source.read_bytes()).hexdigest()
assert sha == '8c10639d5f501d31f114a1f38396bd08515cdec1eaca440a0b8360ccfacb329f'
comparison = json.loads((root / 'validation/expanded-comparison.json').read_text(encoding='utf-8'))
pixels = json.loads((root / 'validation/expanded-pixel-comparison.json').read_text(encoding='utf-8'))
assert all(item['max_rgb565_channel_delta'] <= 1 for item in pixels)
on = comparison['expanded-final-on']
assert on['gpu']['faults'] == 0 and on['gpu']['blends'] > 0
manifest_path = root / 'quickapp-firmware-manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
rpk = root.parents[1] / 'quickapp/velamotion_coach/dist/com.velamotion.coach.huangshan-dev.1.0.0.rpk'
rpk_sha = hashlib.sha256(rpk.read_bytes()).hexdigest()
assert rpk_sha == '5cd17a55d8638676c3447a9f360c240b7babf9e3f168b01a32d969c116fb5c9b'
manifest.update({
    'bytes': source.stat().st_size, 'sha256': sha,
    'validation_date': '2026-09-23',
    'rpk_sha256': rpk_sha, 'rpk_bytes': rpk.stat().st_size,
    'evidence': 'validation/GPU扩展与主线程优化验收.md',
    'ui_variant': 'native-desktop-tools-v2-font-subset-partial-dual-xip-epic-mask-cooperative-stop',
    'performance_comparison': 'validation/expanded-comparison.json',
    'performance_measurement_firmware_sha256': sha,
    'free_heap_after_validation': 5443848,
    'firmware_slot_remaining_bytes': 0x990000-source.stat().st_size,
    'firmware_saved_bytes': 3452060-(source.stat().st_size-5864108),
    'latency_pixel_comparison': 'validation/expanded-pixel-comparison.json',
    'latency_remaining': 'Cached app navigation about 454ms; training median 595ms; cold launch 5776ms. Stop acknowledgement 547ms, storage API callback 857ms from handler entry. GPU mask coverage has not demonstrated a general speedup. Physical touch-to-photon not measured.',
    'epic_mask_enabled_by_default': True,
    'epic_mask_threshold_pixels': 1024,
    'epic_selftest_cases': 16,
    'epic_reboot_test_runs': 5,
    'epic_synthetic_test_operations': 44,
    'epic_runtime_faults': 0,
    'epic_ui_max_irq_us': 2079,
    'epic_primitive_benchmark_max_irq_us': 1779,
    'epic_supported_operations': ['opaque RGB565 fill', 'non-overlapping opaque RGB565 RAM copy', 'single-color A8 mask via L8 palette', 'single-color uniform opacity blend'],
    'epic_text_alpha_transform_acceleration': False,
    'epic_text_alpha_transform_note': 'Eligible final A8 glyph/rounded masks and uniform opacity only; software glyph rasterization, gradients, and transforms retained.',
    'epic_mask_max_rgb565_channel_delta': 1,
    'epic_mask_runtime_strips': on['gpu']['blends'],
    'epic_fallback_test': 'Opaque partial repair; masked pre-submit failure leaves destination untouched; masked wrapper repairs only uncommitted suffix.',
    'epic_pixel_comparison': 'validation/expanded-pixel-comparison.json',
    'epic_corner_audit': 'validation/expanded-corner-audit.json',
    'epic_prior_evidence': 'validation/EPIC适配验收.md',
    'epic_stop_phase_evidence': ['validation/expanded-final-off-analysis.json', 'validation/expanded-final-on-analysis.json'],
    'cooperative_stop_enabled': True,
    'storage_full_payload_uart_log_removed': True,
    'storage_persistent': False,
    'quickapp_async_js': False,
    'latency_target_met': False,
    'rollback_firmware': 'firmware/velamotion-before-epic-expanded.bin',
    'rollback_manifest': 'manifest-before-epic-expanded.json',
})
for dest in (root / 'firmware/velamotion-openvela.bin', Path('D:/wsl_ubuntu/setup/velamotion-openvela.bin')):
    shutil.copyfile(source, dest)
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == sha
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'bytes': manifest['bytes'], 'sha256': sha, 'rpk_bytes': manifest['rpk_bytes']}, indent=2))

"""Verify exported OCI blobs, loaded image identity and write offline provenance."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inspect_oci(path):
    with tarfile.open(path) as archive:
        def read(name):
            return archive.extractfile(name).read()

        index_bytes = read('index.json')
        index = json.loads(index_bytes)
        # No attestations or multiple architectures in this preparation.
        assert len(index['manifests']) == 1, index

        def blob(descriptor):
            algorithm, digest = descriptor['digest'].split(':')
            assert algorithm == 'sha256'
            data = read(f'blobs/sha256/{digest}')
            assert sha256(data) == digest and len(data) == descriptor['size']
            return data

        descriptor = index['manifests'][0]
        manifest = json.loads(blob(descriptor))
        # Buildx can wrap the platform manifest in an OCI index.
        while 'manifests' in manifest:
            assert len(manifest['manifests']) == 1
            descriptor = manifest['manifests'][0]
            manifest = json.loads(blob(descriptor))
        config = json.loads(blob(manifest['config']))
        for layer in manifest['layers']:
            blob(layer)
        return {
            'oci_index_digest': 'sha256:' + sha256(index_bytes),
            'oci_manifest_digest': descriptor['digest'],
            'image_config_digest': manifest['config']['digest'],
            'platform': f"{config['os']}/{config['architecture']}",
        }


def main():
    root, candidate, baseline, version = sys.argv[1:]
    root = Path(root)
    images = []
    for role, revision in [('candidate', candidate), ('baseline', baseline)]:
        for component in ['backend', 'frontend']:
            prefix = f'{role}-{component}'
            image = json.loads((root / 'validation' / f'{prefix}.inspect.json').read_text())[0]
            details = inspect_oci(root / f'{prefix}.oci.tar')
            assert image['Id'] == details['image_config_digest'], (prefix, image['Id'], details)
            labels = image['Config']['Labels']
            assert labels['org.opencontainers.image.revision'] == revision
            assert labels['org.opencontainers.image.source'] == 'https://github.com/L-aros/mailflow-plus'
            images.append({
                'role': role, 'component': component, 'source_sha': revision,
                'source_url': f'https://github.com/L-aros/mailflow-plus/tree/{revision}',
                'tag': f'mailflow-plus/{component}:sha-{revision}',
                'version': labels['org.opencontainers.image.version'],
                **details, 'loaded_image_id': image['Id'], 'registry_manifest_digest': None,
                'docker_archive': f'{prefix}.docker.tar', 'oci_archive': f'{prefix}.oci.tar',
            })
    # Compare the actual started containers to the archive-loaded image IDs.
    decoder = json.JSONDecoder()
    runtime = {}
    for point, role in [('old', 'baseline'), ('candidate', 'candidate'),
                        ('candidate-restored', 'candidate'), ('rollback', 'baseline')]:
        values = []
        for line in (root / 'validation/drill' / f'{point}-runtime-images.txt').read_text().splitlines():
            parts = []
            while line.strip():
                line = line.lstrip()
                value, offset = decoder.raw_decode(line)
                parts.append(value)
                line = line[offset:]
            name, reference, image_id, labels = parts
            if any(reference == item['tag'] for item in images):
                expected = next(item for item in images if item['role'] == role and item['tag'] == reference)
                assert expected['image_config_digest'] == image_id
                values.append({'container': name, 'tag': reference, 'image_id': image_id})
        assert len(values) == 2, (point, values)
        runtime[point] = values
    assert json.loads((root / 'validation/drill/drill-results.json').read_text())['ok'] is True
    assert json.loads((root / 'validation/backup-smoke/backup-smoke.json').read_text())['ok'] is True
    files = {str(p.relative_to(root)).replace('\\', '/'): {'sha256': file_hash(p), 'bytes': p.stat().st_size}
             for p in sorted(root.rglob('*')) if p.is_file() and p.name not in {'SHA256SUMS', 'release-manifest.json'}}
    document = {
        'format': 1, 'status': 'offline-prepared-not-published', 'version': version,
        'source_sha': candidate, 'baseline_sha': baseline,
        'source_url': f'https://github.com/L-aros/mailflow-plus/tree/{candidate}',
        'source_archive': f'source-{candidate}.tar.gz',
        'migration': {'candidate': '0076_webhooks', 'baseline': '0075_gmail_provider_msgid'},
        'platforms_tested': ['linux/amd64'], 'images': images, 'actual_runtime_images': runtime,
        'dependencies': [{'tags': item['RepoTags'], 'image_id': item['Id'],
                          'registry_repo_digests': item.get('RepoDigests', []),
                          'archive': 'dependencies.docker.tar'}
                         for item in json.loads((root / 'validation/dependencies.inspect.json').read_text())],
        'validation': {'drill': 'validation/drill', 'backup_scripts': 'validation/backup-smoke'},
        'ci': {'run_id': os.environ.get('GITHUB_RUN_ID'), 'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
               'verified_sha': os.environ.get('VERIFIED_SHA'),
               'url': f"https://github.com/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}"},
        'digest_note': 'OCI manifest digest addresses the exported OCI manifest. No registry push occurred. Archive SHA256 and image/config IDs are separate values.',
        'licenses': {'root': 'AGPL-3.0 (LICENSE)', 'frontend_package': 'GPL-3.0 (original package metadata)',
                     'backend_package': 'no SPDX license field in original package metadata', 'commercial_notice': 'LICENSE-COMMERCIAL retained'},
        'files': files,
    }
    (root / 'release-manifest.json').write_text(json.dumps(document, indent=2) + '\n')
    files['release-manifest.json'] = {'sha256': file_hash(root / 'release-manifest.json')}
    (root / 'SHA256SUMS').write_text(''.join(f"{entry['sha256']}  {name}\n" for name, entry in sorted(files.items())))
    print(f'Verified {len(images)} OCI manifests and Docker-loaded image identities; no registry publication.')


if __name__ == '__main__':
    main()

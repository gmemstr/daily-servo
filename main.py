import subprocess
import uuid
import os
import hashlib

URL = 'https://arch.dog'

def main():
    filename = os.path.join('/tmp', str(uuid.uuid4()))
    ARGS = ['-z', '-y2', f'-o{filename}', '--resolution=1920x1080']
    print(f'rendering {URL} to {filename}')
    subprocess.run(['/usr/bin/docker', 'run', '--rm', '-v/tmp:/tmp', 'git.gmem.ca/arch/servo:latest'] + ARGS + [URL])
    with open(filename, 'rb') as file_to_check:
        data = file_to_check.read()
        md5_returned = hashlib.md5(data).hexdigest()
        print(md5_returned)


if __name__ == '__main__':
    main()

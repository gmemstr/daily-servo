#!/usr/bin/env bash
set -euo pipefail

TMPDIR="${TMPDIR:-/tmp}"

check_dependencies() {
  local commands=("docker" "sha1sum" "curl" "mktemp" "date" "awk")
  for cmd in "${commands[@]}"; do
    if ! command -v "$cmd" &> /dev/null; then
      echo "Error: $cmd is not available." >&2
      exit 1
    fi
  done
}

snapshot() {
	docker run --dns 1.1.1.1 --rm -v $TMPDIR:/tmp git.gmem.ca/arch/servo:latest "$1" -z -y2 -o"/tmp/$(basename ${2})" --resolution=1920x1080
}

hash() {
	local checksum=$(md5sum "$1" | awk '{print $1}')
	echo "$checksum"
}

update_servo_image() {
	docker pull git.gmem.ca/arch/servo:latest -q > /dev/null
}

post() {
	curl -X POST -H "Authorization: ${1}" \
		 -F date="$(date -I)" \
		 -F hash="${2}" \
		 -F file="@${3}" \
		 "${4}" -s > /dev/null
}

check_dependencies

# Default value for dry-run flag
DRYRUN='false'

# Parse command-line options
while getopts "d-:" opt; do
	case $opt in
		d)
			DRYRUN='true'
			;;
		-)
			case "${OPTARG}" in
				dry-run)
					DRYRUN='true'
					;;
				*)
					echo "Invalid option --${OPTARG}"
					exit 1
					;;
			esac
			;;
		\?)
			echo "Invalid option: -$OPTARG" >&2
			exit 1
			;;
	esac
done

# Shift the parsed options
shift $((OPTIND-1))

# Ensure positional parameters are provided
if [ $# -lt 2 ]; then
	echo "Usage: $0 [--dry-run] <url> <api endpoint>"
	exit 1
fi

url=$1
api=$2

tmpfile="$(mktemp -u)"
echo "Updating local git.gmem.ca/arch/servo:latest"
update_servo_image
echo "Snapshotting $1"
snapshot "$url" "$tmpfile"
checksum=$(hash "$tmpfile")

if [ $DRYRUN = 'false' ]; then
	echo "Sending ${tmpfile} to API"
	post "$SERVO_API_TOKEN" "$checksum" "$tmpfile" "$api"
else
	echo "Dry run specified, not sending $tmpfile to API"
	echo "File hash: $checksum"
fi

echo "Done!"

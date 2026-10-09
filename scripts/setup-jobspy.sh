#!/usr/bin/env sh
set -eu
project_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"${PYTHON:-python3}" -m venv "$project_directory/.venv-jobspy"
"$project_directory/.venv-jobspy/bin/python" -m pip install -r "$project_directory/scripts/requirements-jobspy.txt"
"$project_directory/.venv-jobspy/bin/python" -c "import importlib.metadata; print('JobSpy ' + importlib.metadata.version('python-jobspy') + ' ready')"

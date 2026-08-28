# The flashing tool, on its own so nothing else in the stack carries a Python
# runtime it never uses. Built the first time a device is written to and then
# reused, which is why it is small and pinned.
FROM python:3.12-alpine

# Pinned deliberately: this writes firmware to a device that holds keys, so the
# tool doing the writing should not change underneath you without being asked.
RUN pip install --no-cache-dir esptool==4.8.1

# esptool talks to the board over a serial device passed in with --device.
ENTRYPOINT []

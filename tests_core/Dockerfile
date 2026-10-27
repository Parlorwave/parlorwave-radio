# Real Home Assistant core test runner for the Parlorwave Radio integration.
# HA 2026.9.0 (the local official image, pinned by digest) + the matching
# pytest-homeassistant-custom-component release (0.13.363 pins homeassistant==2026.9.0).
# Test tooling only: nothing here ships, nothing reaches a live Home Assistant.
FROM homeassistant/home-assistant@sha256:372d991e58882a1d8c68c07e9aa3f3b509276e695355f73ccdb03baa70407293
RUN pip install --no-cache-dir "pytest-homeassistant-custom-component==0.13.363" \
 && python3 -c "import homeassistant.const as c; assert c.__version__ == '2026.9.0', c.__version__" \
 && pip check || true
ENTRYPOINT []
WORKDIR /work

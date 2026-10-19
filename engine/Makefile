# Engine developer targets. Everything runs inside Docker so the host needs
# neither Python 3.11 nor ffmpeg.

IMAGE_DEV   ?= ditactic/asr-engine-dev
IMAGE_CPU   ?= ditactic/asr-engine:cpu
IMAGE_CUDA  ?= ditactic/asr-engine:cuda
IMAGE_CONV  ?= ditactic/asr-engine-convert
ENGINE_DIR  := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
MODELS_DIR  ?= $(ENGINE_DIR)/models
RUN_DEV      = docker run --rm -t -v "$(ENGINE_DIR):/app" -v "$(MODELS_DIR):/app/models" -w /app
STAMP        = $(ENGINE_DIR)/.dev-image.stamp

.PHONY: dev-image test test-model lint fmt fixtures shell build-cpu build-cuda convert bench clean

dev-image: $(STAMP)
$(STAMP): Dockerfile.dev requirements.txt requirements-dev.txt
	docker build -f Dockerfile.dev -t $(IMAGE_DEV) .
	@touch $(STAMP)

test: dev-image            ## unit + API tests (no model download)
	$(RUN_DEV) $(IMAGE_DEV) pytest -m "not model" $(PYTEST_ARGS)

test-model: dev-image      ## integration tests with the tiny model (~75 MB into ./models)
	mkdir -p "$(MODELS_DIR)"
	$(RUN_DEV) -e ASR_MODEL=$(or $(ASR_MODEL),tiny) -e ASR_COMPUTE_TYPE=int8 $(IMAGE_DEV) pytest -m model $(PYTEST_ARGS)

lint: dev-image
	$(RUN_DEV) $(IMAGE_DEV) ruff check .

fmt: dev-image
	$(RUN_DEV) $(IMAGE_DEV) ruff check --fix . && $(RUN_DEV) $(IMAGE_DEV) ruff format .

fixtures: dev-image        ## regenerate synthetic test audio
	$(RUN_DEV) $(IMAGE_DEV) python tests/fixtures/make_fixtures.py

shell: dev-image
	docker run --rm -it -v "$(ENGINE_DIR):/app" -v "$(MODELS_DIR):/app/models" -w /app $(IMAGE_DEV) bash

build-cpu:
	docker build -f Dockerfile.cpu -t $(IMAGE_CPU) .

build-cuda:
	docker build -f Dockerfile.cuda -t $(IMAGE_CUDA) .

# make convert SRC=openai/whisper-large-v3-turbo OUT=turbo-int8 QUANT=int8
convert:
	docker build -f Dockerfile.convert -t $(IMAGE_CONV) .
	docker run --rm -v "$(MODELS_DIR):/models" $(IMAGE_CONV) \
	  --model $(SRC) --output_dir /models/$(OUT) --quantization $(or $(QUANT),int8) \
	  --copy_files tokenizer.json preprocessor_config.json

bench: dev-image           ## CPU benchmark with the configured model
	$(RUN_DEV) -e ASR_MODEL=$(or $(ASR_MODEL),tiny) $(IMAGE_DEV) python bench/bench_cpu.py $(BENCH_ARGS)

clean:
	rm -f $(STAMP)
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

FROM python:3.10-slim

# Install system dependencies (ffmpeg, git, curl for Ollama)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama binary inside the container
RUN curl -fsSL https://ollama.com/install.sh | sh

# Set working directory
WORKDIR /app

# Copy requirements and install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Expose Hugging Face default port
EXPOSE 7860

# Startup command: Start Ollama in background, wait 5s, pull mistral model, and launch FastAPI app
CMD bash -c "ollama serve & sleep 5 && ollama pull mistral && uvicorn main:app --host 0.0.0.0 --port 7860"

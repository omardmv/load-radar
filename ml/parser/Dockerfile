# GLiNER2 extraction service for the search parser (CPU only).
#   docker build -t load-radar-gliner2 ml/parser
#   docker run -d --name gliner2 --restart unless-stopped -p 127.0.0.1:7100:7100 -v gliner2-cache:/root/.cache/huggingface load-radar-gliner2
FROM python:3.12-slim
# CPU-only PyTorch wheel: a fraction of the size of the default CUDA build.
RUN pip install --no-cache-dir torch==2.15.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir gliner2==2.1.0 transformers==5.22.1
WORKDIR /app
COPY service.py .
EXPOSE 7100
CMD ["python", "service.py", "7100", "fastino/gliner2-base-v1", "0.0.0.0"]

FROM python:3.12-slim
WORKDIR /app
COPY batocera/kente_lobby.py /app/kente_lobby.py
ENV KENTE_LOBBY_PUBLIC=1 KENTE_LOBBY_PORT=7788 PYTHONUNBUFFERED=1
EXPOSE 7788
CMD ["python", "/app/kente_lobby.py"]

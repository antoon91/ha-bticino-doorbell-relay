import asyncio
import websockets
import subprocess
import sys
import os

async def handle_client(websocket):
    print("🚀 Client connected to Python streamer WebSocket")
    
    # Spawn FFmpeg subprocess with low-latency parameters
    ffmpeg_cmd = [
        'ffmpeg',
        '-y',
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-f', 'h264',
        '-i', 'pipe:0',
        '-c:v', 'copy',
        '-f', 'rtsp',
        'rtsp://localhost:8554/doorbell'
    ]
    
    print(f"Starting FFmpeg process: {' '.join(ffmpeg_cmd)}")
    proc = subprocess.Popen(
        ffmpeg_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    
    # Logger task to monitor FFmpeg output
    async def log_output():
        while True:
            line = await asyncio.to_thread(proc.stderr.readline)
            if not line:
                break
            print(f"[FFmpeg] {line.decode().strip()}", file=sys.stderr)
            
    logger_task = asyncio.create_task(log_output())

    frame_count = 0
    try:
        async for message in websocket:
            if isinstance(message, bytes):
                frame_count += 1
                if frame_count == 1:
                    print(f"📥 Received FIRST frame from browser! Size: {len(message)} bytes")
                elif frame_count % 30 == 0:
                    print(f"📥 Received {frame_count} frames from browser. Last size: {len(message)} bytes")
                
                try:
                    proc.stdin.write(message)
                    proc.stdin.flush()
                except OSError as e:
                    print(f"Error writing to FFmpeg stdin: {e}")
                    break
    except websockets.exceptions.ConnectionClosed:
        print("🔌 WebSocket client disconnected")
    finally:
        print("Terminating FFmpeg process")
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
        logger_task.cancel()

async def main():
    # Allow port reuse and bind to all interfaces inside Docker container
    async with websockets.serve(handle_client, "0.0.0.0", 9999):
        print("Python WebSocket server running on ws://0.0.0.0:9999")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    # Ensure stdout/stderr are unbuffered to see logs immediately in Docker
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Python streamer stopped.")

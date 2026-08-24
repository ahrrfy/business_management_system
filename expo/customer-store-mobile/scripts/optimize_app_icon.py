from pathlib import Path

from PIL import Image

icon_path = Path("/home/ubuntu/customer-store-mobile/assets/images/icon.png")
image = Image.open(icon_path).convert("RGBA")
image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
image.save(icon_path, format="PNG", optimize=True, compress_level=9)

from catalog.images import image_url


def test_url_names_the_pixel_width():
    assert image_url("milk", "thumb") == "/images/milk/120.webp"

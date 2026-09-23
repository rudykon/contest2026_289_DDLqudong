"""Expose CO5300 brightness through the LCD contrast ioctl, idempotently."""
from pathlib import Path
driver = Path('/opt/openvela/src/vendor/sifli/boards/sf32lb52/drivers/lcd/sf32lb_lcd.c')
content = driver.read_text()
if 'VMC_PANEL_BRIGHTNESS' not in content:
    old_get = '''  lcdinfo("Not implemented\\n");
  return -ENOSYS;'''
    start = content.index('static int sf32lb_lcd_getcontrast(')
    end = content.index('static int sf32lb_lcd_getalignment(', start)
    block = content[start:end]
    assert old_get in block
    old_set = '''  lcdinfo("contrast: %d\\n", contrast);
  return -ENOSYS;'''
    assert old_set in block
    block = block.replace(old_get, '''  /* VMC_PANEL_BRIGHTNESS: CO5300 DCS 0x51, cached applied value. */
  FAR struct sf32lb_lcd_dev_s *priv = (FAR struct sf32lb_lcd_dev_s *)dev;
  return priv->contrast;''', 1)
    block = block.replace(old_set, '''  FAR struct sf32lb_lcd_dev_s *priv = (FAR struct sf32lb_lcd_dev_s *)dev;
  if (contrast > CONFIG_LCD_MAXCONTRAST) return -EINVAL;
  if (!s_lcd_hw_ready || !priv->p_drv_ops || !priv->p_drv_ops->p_ops ||
      !priv->p_drv_ops->p_ops->SetBrightness) return -ENOSYS;
  /* The desktop calls this on the same LVGL thread as synchronous PUTAREA. */
  priv->p_drv_ops->p_ops->SetBrightness(&priv->hlcdc,
      (contrast * 100 + CONFIG_LCD_MAXCONTRAST / 2) / CONFIG_LCD_MAXCONTRAST);
  priv->contrast = contrast;
  return OK;''', 1)
    content = content[:start] + block + content[end:]
    assert '    int power;\n' in content
    content = content.replace('    int power;\n', '    int power;\n    unsigned int contrast;\n', 1)
    driver.with_suffix('.before-brightness.c').write_bytes(driver.read_bytes())
    driver.write_text(content)
else:
    content = content.replace(
        'lcddev_ioctl serializes this with PUTAREA; the DMA write waits for completion.',
        'The desktop calls this on the same LVGL thread as synchronous PUTAREA.')
    if content != driver.read_text():
        driver.write_text(content)

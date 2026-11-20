-- Shawn's filament as of his spreadsheet (Nov 19, 2026), for his gmail account.
-- Runs only if he has no filament yet. Swatch colors are approximations, editable in the app.
-- Speeds agreed Nov 19, 2026: Heavy = PLA Black, Matte Charcoal, PETG Black, PETG White; Slow = Purple, Teal.

insert into filament_items (user_id, code, material, subtype, sort, color, hex, main, upstairs, speed)
select u.id, v.code, v.material, v.subtype, v.sort, v.color, v.hex, v.main, v.upstairs, v.speed
from auth.users u
cross join (values
  ('10100','PLA','Basic', 1,'Jade White',      '#F4F4EF',1,1,'normal'),
  ('10201','PLA','Basic', 2,'Beige',           '#F2E3D0',1,0,'normal'),
  ('10402','PLA','Basic', 3,'Sunflower Yellow','#FEC600',1,0,'normal'),
  ('10301','PLA','Basic', 4,'Pumpkin Orange',  '#FF9016',1,0,'normal'),
  ('10300','PLA','Basic', 5,'Orange',          '#FF6A13',1,1,'normal'),
  ('10401','PLA','Basic', 6,'Gold',            '#D4AF37',1,1,'normal'),
  ('10800','PLA','Basic', 7,'Brown',           '#9D432C',1,0,'normal'),
  ('10802','PLA','Basic', 8,'Cocoa Brown',     '#6F4E37',1,0,'normal'),
  ('10205','PLA','Basic', 9,'Maroon Red',      '#8E2433',1,0,'normal'),
  ('10200','PLA','Basic',10,'Red',             '#D32F2F',1,2,'normal'),
  ('10204','PLA','Basic',11,'Hot Pink',        '#F5547C',1,0,'normal'),
  ('10700','PLA','Basic',12,'Purple',          '#5E43B7',1,0,'slow'),
  ('13612','PLA','Basic',13,'Teal',            '#00968F',1,0,'slow'),
  ('10603','PLA','Basic',14,'Cyan',            '#0086D6',1,2,'normal'),
  ('10601','PLA','Basic',15,'Blue',            '#0A3D91',1,0,'normal'),
  ('10502','PLA','Basic',16,'Mistletoe Green', '#3F8E43',1,2,'normal'),
  ('10602','PLA','Basic',17,'Blue Grey',       '#5B6579',1,1,'normal'),
  ('10104','PLA','Basic',18,'Light Grey',      '#C8CACC',0,0,'normal'),
  ('10103','PLA','Basic',19,'Gray',            '#8E9089',1,0,'normal'),
  ('10105','PLA','Basic',20,'Dark Gray',       '#545454',1,1,'normal'),
  ('10101','PLA','Basic',21,'Black',           '#111111',1,2,'heavy'),
  ('11100','PLA','Matte', 1,'Ivory White',     '#F3EFE4',1,0,'normal'),
  ('11300','PLA','Matte', 2,'Mandarin Orange', '#F99963',1,0,'normal'),
  ('11200','PLA','Matte', 3,'Scarlet Red',     '#DE4343',1,0,'normal'),
  ('11602','PLA','Matte', 4,'Dark Blue',       '#1F3A60',1,0,'normal'),
  ('11401','PLA','Matte', 5,'Desert Tan',      '#E8DBB7',1,0,'normal'),
  ('11800','PLA','Matte', 6,'Latte Brown',     '#D3B7A7',1,0,'normal'),
  ('11102','PLA','Matte', 7,'Ash Gray',        '#9B9EA0',1,0,'normal'),
  ('11101','PLA','Matte', 8,'Charcoal',        '#2B2B2B',1,2,'heavy'),
  ('30105','PETG','Basic',1,'Black',           '#111111',0,2,'heavy'),
  ('30800','PETG','Basic',2,'Dark Brown',      '#4D3324',0,1,'normal'),
  ('30107','PETG','Basic',3,'Gray',            '#8A8D8F',0,0,'normal'),
  ('30108','PETG','Basic',4,'Misty Blue',      '#8FA9C4',0,1,'normal'),
  ('30106','PETG','Basic',5,'White',           '#F5F5F5',0,1,'heavy')
) as v(code, material, subtype, sort, color, hex, main, upstairs, speed)
where u.email = 'shawn3401@gmail.com'
  and not exists (select 1 from filament_items f where f.user_id = u.id);

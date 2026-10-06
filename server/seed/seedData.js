const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/anilkabadi';

const users = [
  {
    name: 'Admin',
    email: 'admin@anilkabadi.com',
    phone: '9999999999',
    password: 'admin123',
    role: 'admin',
  },
  {
    name: 'Staff',
    email: 'staff@anilkabadi.com',
    phone: '9999999998',
    password: 'staff123',
    role: 'staff',
  },
  {
    name: 'Rahul Sharma',
    email: 'rahul@example.com',
    phone: '9876543210',
    password: 'password123',
    role: 'customer',
  },
  {
    name: 'Priya Patel',
    email: 'priya@example.com',
    phone: '9876543211',
    password: 'password123',
    role: 'customer',
  },
  {
    name: 'Amit Singh',
    email: 'amit@example.com',
    phone: '9876543212',
    password: 'password123',
    role: 'customer',
  },
];

const categories = [
  { name: 'Engine Parts', description: 'All engine related parts and components' },
  { name: 'Brake System', description: 'Brake pads, discs, calipers and more' },
  { name: 'Suspension & Steering', description: 'Shock absorbers, struts, steering parts' },
  { name: 'Electrical Parts', description: 'Alternators, starters, wiring and electrical components' },
  { name: 'Body Parts', description: 'Bumpers, fenders, doors and body panels' },
  { name: 'Filters', description: 'Oil, air, fuel and cabin filters' },
  { name: 'Clutch Parts', description: 'Clutch plates, bearings and assemblies' },
  { name: 'Transmission Parts', description: 'Gearbox components and transmission parts' },
  { name: 'Cooling System', description: 'Radiators, water pumps and cooling components' },
  { name: 'Exhaust System', description: 'Mufflers, catalytic converters and exhaust pipes' },
  { name: 'Fuel System', description: 'Fuel pumps, injectors and fuel system parts' },
  { name: 'Lighting', description: 'Headlights, tail lights, indicators and bulbs' },
  { name: 'Interior Parts', description: 'Dashboard, seats and interior accessories' },
  { name: 'Exterior Accessories', description: 'Mirrors, wipers and exterior add-ons' },
  { name: 'Tools & Accessories', description: 'Automotive tools and accessories' },
];

const products = [
  {
    name: 'Tata Nexon BS6 Engine Mount',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Nexon',
    compatibleYears: '2020-2024',
    partNumber: '22110-MN510',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Genuine engine mount for Tata Nexon BS6 models. Provides excellent vibration damping and engine stability.',
    price: 2499,
    mrp: 3499,
    stock: 25,
    featured: true,
    specifications: { Material: 'Rubber + Steel', Weight: '2.5 kg', Warranty: '12 months' },
  },
  {
    name: 'Tata Punch BS6 Brake Pad Set',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Punch',
    compatibleYears: '2021-2024',
    partNumber: '58100-ML060',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Front brake pad set for Tata Punch BS6. High friction compound for reliable braking.',
    price: 899,
    mrp: 1299,
    stock: 50,
    featured: true,
    specifications: { Position: 'Front', Material: 'Ceramic Compound', Warranty: '6 months' },
  },
  {
    name: 'Tata Altroz BS6 LED Headlight Assembly',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Altroz',
    compatibleYears: '2020-2024',
    partNumber: '36110-CH500',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Original LED headlight assembly for Tata Altroz BS6. Includes DRL and indicator.',
    price: 8999,
    mrp: 12999,
    stock: 10,
    featured: true,
    specifications: { Type: 'LED', Position: 'Left + Right', DRL: 'Yes' },
  },
  {
    name: 'Tata Tiago BS6 Clutch Plate',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Tiago',
    compatibleYears: '2020-2024',
    partNumber: '22400-MB180',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Genuine clutch plate for Tata Tiago BS6. Smooth engagement and long life.',
    price: 3299,
    mrp: 4599,
    stock: 15,
    featured: false,
    specifications: { Diameter: '200mm', Type: 'Single Plate', Warranty: '12 months' },
  },
  {
    name: 'Tata Harrier BS6 Front Shock Absorber',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Harrier',
    compatibleYears: '2019-2024',
    partNumber: '52650-CH010',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Front shock absorber for Tata Harrier. Ensures smooth ride and excellent handling.',
    price: 4999,
    mrp: 6999,
    stock: 12,
    featured: true,
    specifications: { Position: 'Front Left/Right', Type: 'Hydraulic', Warranty: '12 months' },
  },
  {
    name: 'Tata Safari BS6 Rear Brake Drum',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Safari',
    compatibleYears: '2021-2024',
    partNumber: '58120-CH200',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Rear brake drum for Tata Safari BS6. Precision machined for optimal performance.',
    price: 3499,
    mrp: 4999,
    stock: 8,
    featured: false,
    specifications: { Position: 'Rear', Diameter: '254mm', Material: 'Cast Iron' },
  },
  {
    name: 'Tata Ace BS6 Fuel Injector',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Ace',
    compatibleYears: '2020-2024',
    partNumber: '23600-MA050',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'BS6 compliant fuel injector for Tata Ace. Ensures optimal fuel delivery and efficiency.',
    price: 5999,
    mrp: 7999,
    stock: 6,
    featured: false,
    specifications: { Type: 'Common Rail', 'Flow Rate': '160 cc/min', Warranty: '12 months' },
  },
  {
    name: 'Tata Nexon BS6 Air Filter',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Nexon',
    compatibleYears: '2020-2024',
    partNumber: '16546-MN500',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Genuine air filter for Tata Nexon BS6. High filtration efficiency.',
    price: 399,
    mrp: 599,
    stock: 100,
    featured: false,
    specifications: { Type: 'Dry Panel', Warranty: '6 months' },
  },
  {
    name: 'Used Tata Nexon Engine Head Assembly',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Nexon',
    compatibleYears: '2018-2020',
    partNumber: '11101-MN200',
    condition: 'used_good',
    emissionStandard: 'BS4',
    description: 'Tested and verified engine head assembly from Tata Nexon BS4. Comes with 30-day warranty.',
    price: 15999,
    mrp: 45000,
    stock: 2,
    featured: false,
    specifications: { Condition: 'Tested', Warranty: '30 days', Source: 'Verified' },
  },
  {
    name: 'Used Tata Tiago Gearbox Assembly',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Tiago',
    compatibleYears: '2017-2020',
    partNumber: '22000-MB100',
    condition: 'used_like_new',
    emissionStandard: 'BS4',
    description: 'Low-mileage gearbox assembly from Tata Tiago BS4. Thoroughly inspected.',
    price: 12999,
    mrp: 35000,
    stock: 1,
    featured: false,
    specifications: { GearType: '5-Speed Manual', Warranty: '30 days', Mileage: '~30000 km' },
  },
  {
    name: 'Tata Punch BS6 Rear Bumper',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Punch',
    compatibleYears: '2021-2024',
    partNumber: '72200-ML050',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Original rear bumper for Tata Punch. Perfect fit and finish.',
    price: 4999,
    mrp: 6999,
    stock: 15,
    featured: false,
    specifications: { Position: 'Rear', Material: 'PP Plastic', Color: 'Body Colored' },
  },
  {
    name: 'Maruti Swift Dzire Oil Filter',
    brand: 'Maruti Genuine',
    carBrand: 'Maruti Suzuki',
    carModel: 'Swift Dzire',
    compatibleYears: '2018-2024',
    partNumber: '13780-61M00',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Genuine oil filter for Maruti Swift Dzire BS6. Superior filtration.',
    price: 249,
    mrp: 399,
    stock: 200,
    featured: false,
    specifications: { Type: 'Spin-on', Thread: 'M20x1.5', Warranty: '12 months' },
  },
  {
    name: 'Hyundai Creta BS6 Front Brake Disc',
    brand: 'Hyundai OEM',
    carBrand: 'Hyundai',
    carModel: 'Creta',
    compatibleYears: '2020-2024',
    partNumber: '58110-04200',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Front brake disc for Hyundai Creta BS6. Vented design for better heat dissipation.',
    price: 2999,
    mrp: 4499,
    stock: 20,
    featured: false,
    specifications: { Position: 'Front', Diameter: '280mm', Type: 'Vented' },
  },
  {
    name: 'Tata Harrier BS6 Cabin Air Filter',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Harrier',
    compatibleYears: '2019-2024',
    partNumber: '96000-CH010',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Cabin/pollen filter for Tata Harrier. HEPA grade filtration.',
    price: 599,
    mrp: 899,
    stock: 45,
    featured: false,
    specifications: { Type: 'HEPA', Warranty: '6 months' },
  },
  {
    name: 'Tata Nexon BS6 Radiator',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Nexon',
    compatibleYears: '2020-2024',
    partNumber: '22100-MN520',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Aluminum radiator for Tata Nexon BS6. Excellent cooling performance.',
    price: 6999,
    mrp: 9999,
    stock: 8,
    featured: false,
    specifications: { Material: 'Aluminum', Rows: '26', Warranty: '12 months' },
  },
  {
    name: 'Used Tata Safari BS4 Steering Column',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Safari',
    compatibleYears: '2016-2019',
    partNumber: '56500-CH000',
    condition: 'used_fair',
    emissionStandard: 'BS4',
    description: 'Steering column from Tata Safari BS4. Tested and working. Some cosmetic wear.',
    price: 4999,
    mrp: 18000,
    stock: 1,
    featured: false,
    specifications: { Condition: 'Fair', Warranty: '15 days', Source: 'Verified' },
  },
  {
    name: 'Tata Altroz BS6 Wiper Blade Set',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Altroz',
    compatibleYears: '2020-2024',
    partNumber: '85110-CH300',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Front wiper blade set for Tata Altroz. All-weather performance.',
    price: 699,
    mrp: 999,
    stock: 60,
    featured: false,
    specifications: { Length: '600mm + 400mm', Type: 'Frameless' },
  },
  {
    name: 'Tata Tiago BS6 Tail Light Assembly',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Tiago',
    compatibleYears: '2020-2024',
    partNumber: '36550-MB200',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Rear tail light assembly for Tata Tiago BS6. LED elements with indicator.',
    price: 3999,
    mrp: 5499,
    stock: 18,
    featured: false,
    specifications: { Position: 'Rear Right', Type: 'LED', DRL: 'No' },
  },
  {
    name: 'Mahindra Thar BS6 Clutch Bearing',
    brand: 'Mahindra OEM',
    carBrand: 'Mahindra',
    carModel: 'Thar',
    compatibleYears: '2020-2024',
    partNumber: '22401-MP500',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Release bearing for Mahindra Thar BS6. Smooth and quiet operation.',
    price: 1899,
    mrp: 2799,
    stock: 22,
    featured: false,
    specifications: { Type: 'Hydraulic Release', Warranty: '12 months' },
  },
  {
    name: 'Tata Ace BS6 Alternator',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Ace',
    compatibleYears: '2020-2024',
    partNumber: '31100-MA040',
    condition: 'refurbished',
    emissionStandard: 'BS6',
    description: 'Refurbished alternator for Tata Ace BS6. Tested and certified.',
    price: 5499,
    mrp: 8999,
    stock: 4,
    featured: false,
    specifications: { Output: '12V 80A', Condition: 'Refurbished', Warranty: '6 months' },
  },
  {
    name: 'Tata Nexon BS6 Muffler Assembly',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Nexon',
    compatibleYears: '2020-2024',
    partNumber: '26100-MN530',
    condition: 'new',
    emissionStandard: 'BS6',
    description: 'Rear muffler for Tata Nexon BS6. Compliant with emission norms.',
    price: 7999,
    mrp: 11999,
    stock: 7,
    featured: false,
    specifications: { Material: 'Stainless Steel', Position: 'Rear', Warranty: '12 months' },
  },
  {
    name: 'Tata Punch BS6 Battery',
    brand: 'Exide',
    carBrand: 'Tata',
    carModel: 'Punch',
    compatibleYears: '2021-2024',
    partNumber: '46B24L',
    condition: 'new',
    emissionStandard: 'BS6',
    description: '45Ah maintenance-free battery for Tata Punch. 36-month warranty.',
    price: 4999,
    mrp: 6999,
    stock: 20,
    featured: false,
    specifications: { Capacity: '45Ah', Voltage: '12V', Warranty: '36 months' },
  },
  {
    name: 'Used Tata Harrier BS4 AC Compressor',
    brand: 'Tata OEM',
    carBrand: 'Tata',
    carModel: 'Harrier',
    compatibleYears: '2019-2020',
    partNumber: '97700-CH000',
    condition: 'used_like_new',
    emissionStandard: 'BS4',
    description: 'AC compressor from Tata Harrier BS4. Low mileage, fully functional.',
    price: 8999,
    mrp: 22000,
    stock: 2,
    featured: false,
    specifications: { Refrigerant: 'R134a', Condition: 'Like New', Warranty: '30 days' },
  },
];

const seedDatabase = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    await User.deleteMany({});
    await Category.deleteMany({});
    await Product.deleteMany({});

    console.log('Cleared existing data');

    const createdUsers = [];
    for (const userData of users) {
      createdUsers.push(
        await User.create({
          ...userData,
          emailVerified: true,
          termsAccepted: true,
          termsAcceptedAt: new Date(),
        })
      );
    }
    console.log(`Created ${createdUsers.length} users`);

    const adminUser = createdUsers.find((u) => u.role === 'admin');
    console.log(`Admin credentials: ${adminUser.email} / admin123`);

    const staffUser = createdUsers.find((u) => u.role === 'staff');
    console.log(`Staff credentials: ${staffUser.email} / staff123`);

    const customerUsers = createdUsers.filter((u) => u.role === 'customer');
    console.log(`Customer credentials:`);
    customerUsers.forEach((u) => console.log(`  ${u.email} / password123`));

    const createdCategories = [];
    for (const categoryData of categories) {
      createdCategories.push(await Category.create(categoryData));
    }
    console.log(`Created ${createdCategories.length} categories`);

    const categoryMap = {};
    createdCategories.forEach((cat) => {
      categoryMap[cat.name] = cat._id;
    });

    const productsWithCategory = products.map((product) => {
      let categoryName = 'Engine Parts';
      if (product.name.includes('Brake') || product.name.includes('Drum') || product.name.includes('Disc')) {
        categoryName = 'Brake System';
      } else if (product.name.includes('Shock') || product.name.includes('Suspension') || product.name.includes('Steering')) {
        categoryName = 'Suspension & Steering';
      } else if (product.name.includes('Headlight') || product.name.includes('Tail Light') || product.name.includes('Light')) {
        categoryName = 'Lighting';
      } else if (product.name.includes('Clutch')) {
        categoryName = 'Clutch Parts';
      } else if (product.name.includes('Filter')) {
        categoryName = 'Filters';
      } else if (product.name.includes('Bumper') || product.name.includes('Body')) {
        categoryName = 'Body Parts';
      } else if (product.name.includes('Radiator') || product.name.includes('Cooling')) {
        categoryName = 'Cooling System';
      } else if (product.name.includes('Injector') || product.name.includes('Fuel')) {
        categoryName = 'Fuel System';
      } else if (product.name.includes('Alternator') || product.name.includes('Battery') || product.name.includes('AC')) {
        categoryName = 'Electrical Parts';
      } else if (product.name.includes('Gearbox') || product.name.includes('Muffler')) {
        categoryName = 'Transmission Parts';
      } else if (product.name.includes('Wiper')) {
        categoryName = 'Exterior Accessories';
      } else if (product.name.includes('Cabin')) {
        categoryName = 'Filters';
      }

      return {
        ...product,
        category: categoryMap[categoryName] || categoryMap['Engine Parts'],
      };
    });

    const createdProducts = [];
    for (const productData of productsWithCategory) {
      createdProducts.push(await Product.create(productData));
    }
    console.log(`Created ${createdProducts.length} products`);

    console.log('\n--- Seed Complete ---');
    console.log('Admin: admin@anilkabadi.com / admin123');
    console.log('Staff: staff@anilkabadi.com / staff123');
    console.log('Customer 1: rahul@example.com / password123');
    console.log('Customer 2: priya@example.com / password123');
    console.log('Customer 3: amit@example.com / password123');

    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error.message);
    process.exit(1);
  }
};

seedDatabase();
